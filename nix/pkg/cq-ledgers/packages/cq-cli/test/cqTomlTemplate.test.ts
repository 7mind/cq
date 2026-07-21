/**
 * T331 / T440: Unit tests for CQ_TOML_TEMPLATE (cq-cli/src/cqTomlTemplate.ts).
 *
 * Acceptance:
 *  1. CQ_TOML_TEMPLATE parses without throwing via parseConfig (@cq/config).
 *  2. resolveReviewers / resolvePlanners succeed on the parsed config.
 *  3. The active reviewers+planners each resolve to EXACTLY opus (opus-only
 *     panels — T440): claude:opus only (bare alias — Q252/T509).
 *  4. sonnet and haiku aliases are DEFINED in [aliases] and resolvable, even
 *     though they are off the reviewers/planners panels (T438 decoupling).
 *  5. implement-worker resolves sonnet (standard tier) off-panel via the
 *     [aliases]-wide candidate pool (T438/T440 acceptance criterion).
 *  6. Every commented pi model line is NOT present in the active panel set.
 *  7. cq.toml.example's resolved active model set EQUALS the template's
 *     (consistent with CQ_TOML_TEMPLATE).
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import {
  parseConfig,
  resolveReviewers,
  resolvePlanners,
  resolveAgentModel,
  formatReviewerToken,
  tierModel,
} from "@cq/config";
import { CQ_TOML_TEMPLATE } from "../src/cqTomlTemplate.js";

// Resolve the repo root by walking up 6 levels from this test file's directory:
// test/ -> cq-cli/ -> packages/ -> cq-ledgers/ -> pkg/ -> nix/ -> repo root
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../../../");
const EXAMPLE_PATH = path.join(REPO_ROOT, "cq.toml.example");

// Expected token strings — bare family aliases (Q252/T509): the Claude Code
// Agent tool's per-dispatch `model` override is a closed 4-value enum
// (sonnet | opus | haiku | fable) and rejects full claude-* IDs.
const EXPECTED_OPUS   = "claude:opus";
const EXPECTED_SONNET = "claude:sonnet";
const EXPECTED_HAIKU  = "claude:haiku";

// T440: opus-only panels — the panel list contains exactly one entry.
const EXPECTED_PANEL = [EXPECTED_OPUS];

// Known pi model token strings that must NOT appear in the active panel set.
const PI_INACTIVE_TOKENS = [
  "pi:grok-build/grok-build",
  "pi:ollama-cloud/minimax-m3",
];

describe("CQ_TOML_TEMPLATE (T331/T440)", () => {
  it("parses without throwing (schema-valid)", () => {
    expect(() => parseConfig(CQ_TOML_TEMPLATE)).not.toThrow();
  });

  it("resolveReviewers succeeds (no dangling alias)", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    expect(() => resolveReviewers(config)).not.toThrow();
  });

  it("resolvePlanners succeeds (no dangling alias)", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    expect(() => resolvePlanners(config)).not.toThrow();
  });

  it("active reviewers resolve to EXACTLY opus (opus-only panel, T440)", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    const reviewerTokens = resolveReviewers(config);
    const formatted = reviewerTokens.map(formatReviewerToken);
    expect(formatted).toEqual(EXPECTED_PANEL);
  });

  it("active planners resolve to EXACTLY opus (opus-only panel, T440)", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    const plannerTokens = resolvePlanners(config);
    const formatted = plannerTokens.map(formatReviewerToken);
    expect(formatted).toEqual(EXPECTED_PANEL);
  });

  it("opus alias resolves to the expected claude token (string-equality)", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    const opusToken = config.aliases["opus"];
    expect(opusToken).toBeDefined();
    expect(formatReviewerToken(opusToken!)).toBe(EXPECTED_OPUS);
  });

  it("sonnet alias is DEFINED in [aliases] even though it is off the panels", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    const sonnetToken = config.aliases["sonnet"];
    expect(sonnetToken).toBeDefined();
    expect(formatReviewerToken(sonnetToken!)).toBe(EXPECTED_SONNET);
  });

  it("haiku alias is DEFINED in [aliases] even though it is off the panels", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    const haikuToken = config.aliases["haiku"];
    expect(haikuToken).toBeDefined();
    expect(formatReviewerToken(haikuToken!)).toBe(EXPECTED_HAIKU);
  });

  it("fable is a LIVE but INERT alias — defined, named by no [tiers] entry, off panels", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE); // default harness = claude
    const fable = config.aliases["fable"];
    expect(fable).toBeDefined();
    expect(formatReviewerToken(fable!)).toBe("claude:fable");
    // No claude tier maps to fable => it is never dispatched.
    for (const tier of ["frontier", "standard", "fast"] as const) {
      expect(formatReviewerToken(tierModel(config, tier)!)).not.toBe("claude:fable");
    }
    // Not on the active claude panels.
    const panel = new Set([
      ...resolveReviewers(config).map(formatReviewerToken),
      ...resolvePlanners(config).map(formatReviewerToken),
    ]);
    expect(panel.has("claude:fable")).toBe(false);
  });

  it("pi harness: [harness.pi] panels + [harness.pi.tiers] resolve grok/codex", () => {
    const pi = parseConfig(CQ_TOML_TEMPLATE, "pi");
    expect(resolveReviewers(pi).map(formatReviewerToken)).toEqual([
      "pi:grok-build/grok-build:high",
      "pi:openai-codex/gpt-5.6-sol:xhigh",
    ]);
    expect(resolvePlanners(pi).map(formatReviewerToken)).toEqual([
      "pi:openai-codex/gpt-5.6-sol:xhigh",
    ]);
    // Per-role dispatch under pi is a direct [harness.pi.tiers] lookup (which
    // replaces the shared claude tiers): frontier -> codex (sol), standard ->
    // terra, fast -> luna (the GPT-5.6 capability ladder).
    expect(formatReviewerToken(resolveAgentModel(pi, "implement-reviewer"))).toBe(
      "pi:openai-codex/gpt-5.6-sol:xhigh",
    );
    expect(formatReviewerToken(resolveAgentModel(pi, "implement-worker"))).toBe(
      "pi:openai-codex/gpt-5.6-terra:high",
    );
  });

  it("implement-worker resolves sonnet (standard tier) via [tiers] tier->model lookup", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    const workerToken = resolveAgentModel(config, "implement-worker");
    expect(formatReviewerToken(workerToken)).toBe(EXPECTED_SONNET);
  });

  it("no pi model token appears in the active reviewer panel", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    const reviewerTokens = resolveReviewers(config);
    const formatted = new Set(reviewerTokens.map(formatReviewerToken));
    for (const piToken of PI_INACTIVE_TOKENS) {
      expect(formatted.has(piToken)).toBe(false);
    }
  });

  it("no pi model token appears in the active planner panel", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    const plannerTokens = resolvePlanners(config);
    const formatted = new Set(plannerTokens.map(formatReviewerToken));
    for (const piToken of PI_INACTIVE_TOKENS) {
      expect(formatted.has(piToken)).toBe(false);
    }
  });

  it("[tiers] is non-null (all active aliases classified)", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    expect(config.tiers).not.toBeNull();
  });

  it("[agent_tiers] is non-null", () => {
    const config = parseConfig(CQ_TOML_TEMPLATE);
    expect(config.agentTiers).not.toBeNull();
  });

  it("[agent_efforts] block is COMMENTED-OUT/inert — agentEfforts resolves to {} (T518/Q254)", () => {
    // The template documents [agent_efforts] as a commented-out example; if a
    // future edit uncomments it (silently overriding an agent's effort), this
    // fails against the REAL exported constant.
    const config = parseConfig(CQ_TOML_TEMPLATE);
    expect(config.agentEfforts).toEqual({});
  });

  it("[ledger] backend defaults to 'xdg' for a fresh cq init (T501)", () => {
    // Guards the T501 acceptance against the REAL exported constant: a future
    // edit that silently changes the fresh-init default backend (or reverts to
    // the pre-T501 fs default) fails here. A synthetic copy in config.test.ts
    // cannot catch that drift — only parsing CQ_TOML_TEMPLATE itself can.
    const config = parseConfig(CQ_TOML_TEMPLATE);
    expect(config.ledger).not.toBeNull();
    expect(config.ledger?.backend).toBe("xdg");
    // backup / projectId stay at their documented (commented-out) defaults.
    expect(config.ledger?.backup).toBe("none");
    expect(config.ledger?.projectId).toBeNull();
  });

  it("documents the commented-out backend='postgres' + url example, with the secret-hygiene warning (T584)", () => {
    // The postgres example is COMMENTED OUT (the active [ledger] table stays
    // backend='xdg', asserted above) — so this checks the rendered TEXT, not
    // the parsed config. parseConfig succeeding (first test in this describe)
    // already proves the extra commented lines don't break TOML parsing.
    expect(CQ_TOML_TEMPLATE).toContain('backend = "postgres"');
    expect(CQ_TOML_TEMPLATE).toContain("url     = ");
    expect(CQ_TOML_TEMPLATE).toContain("SECRET HYGIENE");
    expect(CQ_TOML_TEMPLATE).toContain("CQ_LEDGER_PG_URL");
    expect(CQ_TOML_TEMPLATE).toContain("DATABASE_URL");
  });

  it("documents the commented-out [project].name key (T570/T584)", () => {
    expect(CQ_TOML_TEMPLATE).toContain("[project]");
    expect(CQ_TOML_TEMPLATE).toContain('name = "my-project"');
    // [project] stays absent from the ACTIVE (uncommented) config.
    const config = parseConfig(CQ_TOML_TEMPLATE);
    expect(config.project).toBeNull();
  });
});

describe("cq.toml.example active model set equals CQ_TOML_TEMPLATE (T331/T440)", () => {
  it("cq.toml.example parses without throwing", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    expect(() => parseConfig(contents)).not.toThrow();
  });

  it("cq.toml.example active reviewers EQUAL template active reviewers (set equality)", () => {
    const templateConfig = parseConfig(CQ_TOML_TEMPLATE);
    const exampleConfig = parseConfig(readFileSync(EXAMPLE_PATH, "utf8"));

    const templateReviewers = resolveReviewers(templateConfig).map(formatReviewerToken).sort();
    const exampleReviewers  = resolveReviewers(exampleConfig).map(formatReviewerToken).sort();

    expect(exampleReviewers).toEqual(templateReviewers);
  });

  it("cq.toml.example active planners EQUAL template active planners (set equality)", () => {
    const templateConfig = parseConfig(CQ_TOML_TEMPLATE);
    const exampleConfig = parseConfig(readFileSync(EXAMPLE_PATH, "utf8"));

    const templatePlanners = resolvePlanners(templateConfig).map(formatReviewerToken).sort();
    const examplePlanners  = resolvePlanners(exampleConfig).map(formatReviewerToken).sort();

    expect(examplePlanners).toEqual(templatePlanners);
  });

  it("cq.toml.example active reviewers resolve to EXACTLY opus (opus-only panel, T440)", () => {
    const config = parseConfig(readFileSync(EXAMPLE_PATH, "utf8"));
    const formatted = resolveReviewers(config).map(formatReviewerToken);
    expect(formatted).toEqual(EXPECTED_PANEL);
  });

  it("cq.toml.example active planners resolve to EXACTLY opus (opus-only panel, T440)", () => {
    const config = parseConfig(readFileSync(EXAMPLE_PATH, "utf8"));
    const formatted = resolvePlanners(config).map(formatReviewerToken);
    expect(formatted).toEqual(EXPECTED_PANEL);
  });

  it("cq.toml.example [agent_efforts] block is COMMENTED-OUT/inert — agentEfforts is {} (T518/Q254)", () => {
    const config = parseConfig(readFileSync(EXAMPLE_PATH, "utf8"));
    expect(config.agentEfforts).toEqual({});
  });

  it("cq.toml.example [ledger] block is COMMENTED-OUT/inert — backend resolves to fs", () => {
    const config = parseConfig(readFileSync(EXAMPLE_PATH, "utf8"));
    expect(config.ledger).toBeNull();
  });
});
