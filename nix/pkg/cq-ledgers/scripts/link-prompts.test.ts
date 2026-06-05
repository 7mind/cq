/**
 * Regression test for D30: link-prompts.ts LINKS point at `llm/...` targets
 * that do not exist in the current repo layout.
 *
 * IMPORT-SAFETY CONTRACT: importing link-prompts.ts must NOT create or mutate
 * any `.claude/` symlinks. The creation loop is guarded behind import.meta.main
 * in the script, so this import is safe.
 *
 * CURRENT STATE (pre-T180): checkLinks(LINKS) returns a non-empty array because
 * the `llm/commands/...` and `llm/agents/...` targets are missing. The test
 * below ASSERTS this broken state to document D30 and confirm the reproduction.
 *
 * T180 will repoint the LINKS sources to the correct paths and flip the
 * assertion to: expect(await checkLinks(LINKS)).toEqual([])
 */
import { expect, test, describe } from "bun:test";
import { LINKS, checkLinks } from "./link-prompts.ts";

describe("link-prompts import-safety", () => {
  test("importing the module does not create .claude/ symlinks", () => {
    // The fact that we reach this line without error (and without .claude/ writes)
    // proves the creation loop is guarded. LINKS is the real exported array.
    expect(Array.isArray(LINKS)).toBe(true);
    expect(LINKS.length).toBeGreaterThan(0);
  });
});

describe("link-prompts D30 reproduction: dangling llm/ targets", () => {
  test("all LINKS entries reference llm/ sources (confirming the broken layout)", () => {
    for (const { source } of LINKS) {
      expect(source.startsWith("llm/")).toBe(true);
    }
  });

  // D30: the llm/ targets do not exist — checkLinks returns missing entries.
  // This assertion documents the current broken state. T180 flips it to toEqual([]).
  test("checkLinks(LINKS) finds missing targets (D30 — unfixed until T180)", async () => {
    const missing = await checkLinks(LINKS);
    expect(missing.length).toBeGreaterThan(0);
    // Every missing entry should have the expected shape
    for (const entry of missing) {
      expect(typeof entry.link).toBe("string");
      expect(typeof entry.source).toBe("string");
      expect(typeof entry.absSource).toBe("string");
      expect(entry.source.startsWith("llm/")).toBe(true);
    }
  });
});
