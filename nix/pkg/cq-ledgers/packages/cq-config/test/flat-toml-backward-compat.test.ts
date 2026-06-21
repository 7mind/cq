/**
 * T479: Regression guard — a flat cq.toml with no [harness.*] blocks must
 * parse identically under any active harness argument.
 *
 * Acceptance (Q239): a cq.toml with no [harness.*] keeps working unchanged.
 * A future change to the layered-merge logic in parseConfig must not silently
 * regress flat configs by producing different results for different harnesses.
 *
 * This test uses the repo's own cq.toml.example, which is authoritative: it
 * is the shipped template and has no [harness.*] blocks by design.  Parsing it
 * with harness='pi', harness='claude', and the default (no argument) must yield
 * structurally identical CqConfig objects across all three calls.
 *
 * Uses parseConfig (not loadConfig) so the test reads cq.toml.example directly
 * and does not depend on the gitignored live cq.toml being present.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { parseConfig } from "../src/index.js";

// Resolve the repo root by walking up 6 levels from this test file's directory:
// test/ -> cq-config/ -> packages/ -> cq-ledgers/ -> pkg/ -> nix/ -> repo root
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../../../");
const EXAMPLE_PATH = path.join(REPO_ROOT, "cq.toml.example");

describe("flat cq.toml backward-compat — T479 (Q239 regression guard)", () => {
  it("cq.toml.example has no [harness.*] blocks (precondition)", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    // A [harness.*] block in TOML would appear as `[harness.` at the start of a
    // non-comment line.  The example must not have any such line.
    const harnessLine = contents
      .split("\n")
      .find((line) => /^\[harness\./.test(line));
    expect(harnessLine).toBeUndefined();
  });

  it("parseConfig with harness='pi', harness='claude', and default all produce deep-equal CqConfig", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");

    const underPi = parseConfig(contents, "pi");
    const underClaude = parseConfig(contents, "claude");
    const underDefault = parseConfig(contents); // default == DEFAULT_HARNESS ('claude')

    // All three must be structurally identical — no harness-specific overrides
    // means the merge logic must be a no-op regardless of which harness is active.
    expect(underPi).toEqual(underClaude);
    expect(underPi).toEqual(underDefault);
  });

  it("the shared aliases/reviewers/planners/tiers are intact under all harnesses", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");

    for (const harness of ["pi", "claude"] as const) {
      const config = parseConfig(contents, harness);

      // reviewers and planners are non-empty arrays of alias strings.
      expect(config.reviewers.length).toBeGreaterThan(0);
      expect(config.planners.length).toBeGreaterThan(0);

      // aliases map is populated.
      expect(Object.keys(config.aliases).length).toBeGreaterThan(0);

      // Each reviewer alias resolves through [aliases].
      for (const alias of config.reviewers) {
        expect(config.aliases[alias]).toBeDefined();
      }
      for (const alias of config.planners) {
        expect(config.aliases[alias]).toBeDefined();
      }

      // tiers and agentTiers were parsed (the example has both tables).
      expect(config.tiers).not.toBeNull();
      expect(config.agentTiers).not.toBeNull();
    }
  });
});
