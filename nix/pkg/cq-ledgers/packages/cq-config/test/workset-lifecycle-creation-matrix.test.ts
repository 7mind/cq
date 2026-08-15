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

describe("T1986 lifecycle creation routing matrix", () => {
  test("names every owner-scoped CQ creation kind and rejects ownerless restrictive intake", () => {
    expect(existsSync(FRAGMENT)).toBe(true);
    if (!existsSync(FRAGMENT)) return;
    const source = readFileSync(FRAGMENT, "utf8");
    const normalized = source.replace(/\s+/g, " ");
    for (const kind of [
      "idea-to-goal",
      "exact-gate-question",
      "review",
      "review-filed-defect",
      "implementation-defect",
      "research",
      "hypothesis",
      "decision",
      "fix-goal",
      "handoff",
    ]) {
      expect(source, kind).toContain(`\`${kind}\``);
    }
    expect(normalized).toContain("reject the entire ownerless intake before its first mutation");
  });
});
