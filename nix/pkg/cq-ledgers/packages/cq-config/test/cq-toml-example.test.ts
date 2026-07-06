/**
 * T234: Reproducible test that verifies cq.toml.example (repo root) is
 * provider-qualified and resolves correctly under the T231 grammar.
 *
 * T274: Added regression guard — parseConfig on cq.toml.example must
 * succeed with no CqConfigError (ensures the shipped example always stays
 * valid under the current grammar), plus semantic assertions
 * (tierModel / resolveAgentModel) that catch a regression in the
 * tier->model [tiers] map, not just a parse failure.
 *
 * Acceptance:
 *  - The file contains no bare slash-free `pi:<word>` tokens.
 *  - parseConfig resolves the minimax alias to {harness:'pi', model:'minimax-m3', provider:'ollama-cloud'}.
 *  - parseConfig resolves codex and grok aliases to {harness:'pi', model:'grok-build', provider:'grok-build'}.
 *  - parseConfig does NOT throw (T274 regression guard).
 *  - tierModel(config, "frontier") returns the opus token (semantic guard).
 *  - resolveAgentModel for 'plan-reviewer' returns the opus token
 *    (semantic end-to-end guard).
 *
 * Uses parseConfig (not loadConfig) so the test reads cq.toml.example
 * directly and does not depend on the gitignored live cq.toml being present.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import {
  parseConfig,
  tierModel,
  resolveAgentModel,
  type CqConfig,
} from "../src/index.js";

// Resolve the repo root by walking up 6 levels from this test file's directory:
// test/ -> cq-config/ -> packages/ -> cq-ledgers/ -> pkg/ -> nix/ -> repo root
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../../../");
const EXAMPLE_PATH = path.join(REPO_ROOT, "cq.toml.example");

// T274: Regression guard — the example file must parse cleanly with no CqConfigError.
describe("cq.toml.example — T274 regression guard: no CqConfigError", () => {
  it("parseConfig on cq.toml.example does not throw CqConfigError", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    expect(() => parseConfig(contents)).not.toThrow();
  });

  it("parseConfig on cq.toml.example yields a non-null tiers config", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    // The example has a [tiers] block, so tiers must be non-null.
    expect(config.tiers).not.toBeNull();
  });

  it("parseConfig on cq.toml.example yields non-null agentTiers", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(config.agentTiers).not.toBeNull();
  });

  it("parseConfig on cq.toml.example — [tiers] entries carry resolved tokens", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    // Each entry in the parsed tiers.entries must have a resolved token
    // (not an alias stub) — confirms the tier->model map values are resolved
    // through [aliases] and parsed correctly.
    expect(config.tiers!.entries.length).toBeGreaterThan(0);
    for (const entry of config.tiers!.entries) {
      expect(entry.token.harness === "claude" || entry.token.harness === "pi").toBe(true);
      expect(entry.token.model).toBeTruthy();
    }
  });

  it("tierModel — 'frontier' resolves to the opus token (semantic map guard)", () => {
    // This test exercises the tier->model lookup itself, not just the parser.
    // A regression in tierModel (wrong equality, wrong return, wrong lookup)
    // would be caught here even if parseConfig still passes.
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(tierModel(config, "frontier")).toEqual(config.aliases["opus"]!);
  });

  it("tierModel — 'standard' resolves to sonnet and 'fast' resolves to haiku", () => {
    // The example [tiers] block maps standard = "sonnet" and fast = "haiku"
    // (alias-value form). Verify both are resolved through [aliases] to the
    // correct token, covering the remaining tiers of the map.
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(tierModel(config, "standard")).toEqual(config.aliases["sonnet"]!);
    expect(tierModel(config, "fast")).toEqual(config.aliases["haiku"]!);
  });

  it("resolveAgentModel — 'plan-reviewer' resolves to the opus token (end-to-end semantic guard)", () => {
    // plan-reviewer has agent_tiers entry 'frontier'; [tiers] maps frontier to
    // opus in the example.  This guard catches a regression in the full
    // resolveAgentModel pipeline (agent -> tier -> model).
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    const resolved = resolveAgentModel(config, "plan-reviewer");
    expect(resolved).toEqual(config.aliases["opus"]!);
  });
});

describe("cq.toml.example — T234 provider-qualification checks", () => {
  it("contains no bare slash-free pi:<word> tokens", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    // Match any `pi:` followed by one or more non-slash, non-whitespace, non-quote chars
    // without a subsequent `/` before the closing quote — i.e. a bare pi token.
    const bareMatch = contents.match(/"pi:[^/"'\s]+"/g);
    expect(bareMatch).toBeNull();
  });

  it("resolves minimax alias to {harness:'pi', model:'minimax-m3', provider:'ollama-cloud'}", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(config.aliases["minimax"]).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
      effort: null,
    });
  });

  it("resolves codex alias to {harness:'pi', model:'grok-build', provider:'grok-build'}", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(config.aliases["codex"]).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
      effort: null,
    });
  });

  it("resolves grok alias to {harness:'pi', model:'grok-build', provider:'grok-build'}", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(config.aliases["grok"]).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
      effort: null,
    });
  });
});
