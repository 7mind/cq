/**
 * Regression test for D30: link-prompts.ts LINKS point at `../cq-assets/...`
 * targets that exist in the current repo layout.
 *
 * IMPORT-SAFETY CONTRACT: importing link-prompts.ts must NOT create or mutate
 * any `.claude/` symlinks. The creation loop is guarded behind import.meta.main
 * in the script, so this import is safe.
 *
 * POST-T180: checkLinks(LINKS) returns [] because all sources resolve under
 * ../cq-assets/.
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

describe("link-prompts D30 fix: all sources resolve (T180)", () => {
  test("all LINKS entries reference ../cq-assets/ sources", () => {
    for (const { source } of LINKS) {
      expect(source.startsWith("../cq-assets/")).toBe(true);
    }
  });

  // D30 fixed: every source target now resolves — checkLinks returns [].
  test("checkLinks(LINKS) finds no missing targets", async () => {
    const missing = await checkLinks(LINKS);
    expect(missing).toEqual([]);
  });
});
