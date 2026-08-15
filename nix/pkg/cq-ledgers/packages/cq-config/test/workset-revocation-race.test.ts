import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const FRAGMENT = join(
  REPOSITORY_ROOT,
  "nix",
  "pkg",
  "cq-assets",
  "fragments",
  "workset-effect-discipline.md",
);

describe("T1986 command revocation protocol", () => {
  test("requires one admission through observable completion and a fresh membership read", () => {
    expect(existsSync(FRAGMENT)).toBe(true);
    if (!existsSync(FRAGMENT)) return;
    const source = readFileSync(FRAGMENT, "utf8");
    const normalized = source.replace(/\s+/g, " ");
    expect(normalized).toContain("one admission");
    expect(source).toContain("observable completion");
    expect(source).toContain("Re-read `workset({ op: \"get\"");
    expect(source).toContain("reject the whole batch before its first effect");
  });
});
