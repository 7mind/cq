/**
 * T331 / T440: Unit tests for CQ_TOML_TEMPLATE (cq-cli/src/cqTomlTemplate.ts).
 *
 * Acceptance:
 *  1. CQ_TOML_TEMPLATE parses without throwing via parseConfig (@cq/config).
 *  2. resolveReviewers / resolvePlanners succeed on the parsed config.
 *  3. The active reviewers+planners each resolve to EXACTLY opus (opus-only
 *     panels — T440): claude:opus-4.8[1m] only.
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

// Expected token strings.
const EXPECTED_OPUS   = "claude:opus-4.8[1m]";
const EXPECTED_SONNET = "claude:sonnet-5";
const EXPECTED_HAIKU  = "claude:haiku-4.5";

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
    expect(formatReviewerToken(fable!)).toBe("claude:fable-5");
    // No claude tier maps to fable => it is never dispatched.
    for (const tier of ["frontier", "standard", "fast"] as const) {
      expect(formatReviewerToken(tierModel(config, tier)!)).not.toBe("claude:fable-5");
    }
    // Not on the active claude panels.
    const panel = new Set([
      ...resolveReviewers(config).map(formatReviewerToken),
      ...resolvePlanners(config).map(formatReviewerToken),
    ]);
    expect(panel.has("claude:fable-5")).toBe(false);
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

  it("[ledger] block is COMMENTED-OUT/inert — backend resolves to fs (ledger null)", () => {
    // Guards the T349 acceptance against the REAL exported constant: if a future
    // edit uncomments the template's [ledger] block (silently activating
    // git-object), this fails. A synthetic copy in config.test.ts cannot catch
    // that drift — only parsing CQ_TOML_TEMPLATE itself can.
    const config = parseConfig(CQ_TOML_TEMPLATE);
    expect(config.ledger).toBeNull();
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

  it("cq.toml.example [ledger] block is COMMENTED-OUT/inert — backend resolves to fs", () => {
    const config = parseConfig(readFileSync(EXAMPLE_PATH, "utf8"));
    expect(config.ledger).toBeNull();
  });
});
