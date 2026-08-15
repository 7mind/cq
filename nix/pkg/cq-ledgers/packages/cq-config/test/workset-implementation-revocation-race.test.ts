import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = join(REPOSITORY_ROOT, "nix", "pkg", "cq-assets");

describe("T1987 implementation revocation protocol", () => {
  test("holds one admission through observable effects and re-derives before the next target", () => {
    const fragment = readFileSync(
      join(ASSETS_ROOT, "fragments", "workset-effect-discipline.md"),
      "utf8",
    );
    const advance = readFileSync(
      join(ASSETS_ROOT, "commands", "cq", "implement", "advance.md"),
      "utf8",
    );
    expect(advance).toContain("{{cq:fragment:workset-effect-discipline}}");
    expect(fragment).toMatch(/one\s+admission/);
    expect(fragment).toContain("observable completion");
    expect(fragment).toContain("Re-read `workset({ op: \"get\"");
    expect(advance.indexOf("worktree_manage({ operation: \"prepare\"")).toBeLessThan(
      advance.indexOf("Set the task `wip`"),
    );
  });
});
