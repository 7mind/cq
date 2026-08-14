import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const PLAN_PROMPTS = [
  path.join(ASSETS_ROOT, "commands", "cq", "plan.md"),
  path.join(ASSETS_ROOT, "commands", "cq", "plan", "follow-up.md"),
] as const;

const AMBIENT_IDEA_POLICY = [
  "Create or update each idea without `milestone_id`; the server attaches it to `M-AMBIENT`.",
  "Ideas never attach to work milestones and are not archived with them.",
  "`ledgerRefs` linking remains independent of milestone attachment.",
] as const;

describe("ambient-only idea planning prompts [Behavioral-Active, Blackbox-Atomic]", () => {
  for (const promptPath of PLAN_PROMPTS) {
    test(`${path.relative(ASSETS_ROOT, promptPath)} carries the complete attachment policy`, () => {
      const source = readFileSync(promptPath, "utf8");
      for (const fact of AMBIENT_IDEA_POLICY) expect(source).toContain(fact);
      expect(source).not.toMatch(/create_item\([^\n]*ideas[^\n]*milestone_id/u);
    });
  }
});
