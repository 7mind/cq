import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ADVANCE = join(
  REPOSITORY_ROOT,
  "nix",
  "pkg",
  "cq-assets",
  "commands",
  "cq",
  "implement",
  "advance.md",
);
const DISCIPLINE = join(
  REPOSITORY_ROOT,
  "nix",
  "pkg",
  "cq-assets",
  "fragments",
  "workset-effect-discipline.md",
);

describe("T1987 implementation lifecycle routing matrix", () => {
  test("uses guarded lifecycle, owned creation, dispatch, and Git effect surfaces", () => {
    const source = readFileSync(ADVANCE, "utf8");
    const discipline = readFileSync(DISCIPLINE, "utf8");
    for (const operation of ["worktree_manage", "claim_plan", "publish_plan_draft"] as const) {
      const routedSource = operation === "worktree_manage" ? source : discipline;
      expect(routedSource, operation).toContain(operation);
    }
    expect(source).toContain('owner_ref: "tasks:<T>"');
    expect(source).toContain('creation_kind: "implementation-defect"');
    expect(source).toContain('creation_kind: "exact-gate-question"');
    expect(source).not.toContain("git worktree remove");
  });
});
