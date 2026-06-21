/**
 * T475: toml.ts parsing of `[harness.<name>]` per-harness override tables (Q240).
 *
 * This task covers ONLY the parsing layer (parseToml -> RawToml.harnessOverrides);
 * the merge into CqConfig is the downstream task T477.
 *
 * Acceptance:
 *  - a doc with [harness.pi] reviewers/planners/[harness.pi.tiers] parses into
 *    RawToml.harnessOverrides.pi with those raw sections;
 *  - a doc with NO [harness.*] yields harnessOverrides=null;
 *  - [harness.pi.aliases] / [harness.bogus] / [harness.pi.webui] each throw a
 *    precise TomlSyntaxError naming the offending key/harness.
 */

import { describe, it, expect } from "bun:test";
import { parseToml } from "../src/index.js";

describe("parseToml — [harness.<name>] override tables (T475 / Q240)", () => {
  it("parses [harness.pi] reviewers/planners/[harness.pi.tiers] into harnessOverrides.pi", () => {
    const doc = `
reviewers = ["claude:opus-4.8"]

[harness.pi]
reviewers = ["pi:ollama-cloud/minimax-m3"]
planners = ["pi:grok-build/grok-build"]

[harness.pi.tiers]
"pi:ollama-cloud/minimax-m3" = "fast"
`;
    const raw = parseToml(doc);
    expect(raw.harnessOverrides).not.toBeNull();
    const pi = raw.harnessOverrides!.pi!;
    expect(pi).toBeDefined();
    expect(pi.reviewers).toEqual(["pi:ollama-cloud/minimax-m3"]);
    expect(pi.planners).toEqual(["pi:grok-build/grok-build"]);
    expect(pi.tiers).toEqual({ "pi:ollama-cloud/minimax-m3": "fast" });
    // Only pi was overridden.
    expect(Object.keys(raw.harnessOverrides!)).toEqual(["pi"]);
  });

  it("parses a [harness.claude] block with a subset of keys", () => {
    const doc = `
[harness.claude]
reviewers = ["claude:opus-4.8"]
`;
    const raw = parseToml(doc);
    const claude = raw.harnessOverrides!.claude!;
    expect(claude.reviewers).toEqual(["claude:opus-4.8"]);
    expect(claude.planners).toBeNull();
    expect(claude.tiers).toBeNull();
  });

  it("yields harnessOverrides=null when no [harness.*] table is present", () => {
    const doc = `
reviewers = ["claude:opus-4.8"]
planners = ["claude:sonnet-4.5"]
`;
    const raw = parseToml(doc);
    expect(raw.harnessOverrides).toBeNull();
  });

  it("rejects [harness.pi.aliases] (SHARED-only key) with a precise error", () => {
    const doc = `
[harness.pi.aliases]
foo = "pi:ollama-cloud/minimax-m3"
`;
    expect(() => parseToml(doc)).toThrow(
      'cq.toml: unexpected key "aliases" in [harness.pi] (only reviewers, planners, tiers may be overridden per-harness)',
    );
  });

  it("rejects [harness.pi.webui] (SHARED-only key) with a precise error", () => {
    const doc = `
[harness.pi.webui]
port = 8080
`;
    expect(() => parseToml(doc)).toThrow(
      'cq.toml: unexpected key "webui" in [harness.pi] (only reviewers, planners, tiers may be overridden per-harness)',
    );
  });

  it("rejects [harness.pi.ledger] (SHARED-only key) with a precise error", () => {
    const doc = `
[harness.pi.ledger]
backend = "git"
`;
    expect(() => parseToml(doc)).toThrow(
      'cq.toml: unexpected key "ledger" in [harness.pi]',
    );
  });

  it("rejects [harness.pi.agent_tiers] (SHARED-only key) with a precise error", () => {
    const doc = `
[harness.pi.agent_tiers]
"fast-agent" = "fast"
`;
    expect(() => parseToml(doc)).toThrow(
      'cq.toml: unexpected key "agent_tiers" in [harness.pi]',
    );
  });

  it("rejects an unknown harness name [harness.bogus] with a precise error", () => {
    const doc = `
[harness.bogus]
reviewers = ["claude:opus-4.8"]
`;
    expect(() => parseToml(doc)).toThrow(
      'cq.toml: unknown harness "bogus" in [harness.bogus] (expected "claude" or "pi")',
    );
  });

  it("rejects a non-string entry in a per-harness reviewers array", () => {
    const doc = `
[harness.pi]
reviewers = ["pi:ollama-cloud/minimax-m3", 42]
`;
    expect(() => parseToml(doc)).toThrow(
      "cq.toml: harness.pi.reviewers[1] must be a string",
    );
  });
});
