/**
 * T484: Regression guard — the documented [harness.pi] sample in cq.toml.example
 * (the commented block at the end of that file) must parse correctly when
 * uncommented and loaded with harness='pi'.
 *
 * This test inlines the documented sample verbatim (uncommented), so any drift
 * between the documented example and the actual parseConfig semantics is caught.
 *
 * Acceptance:
 *  - parseConfig(sample, 'pi') yields reviewers=["grok","minimax"],
 *    planners=["grok"] (per-harness panel, REPLACING the shared opus-only panel).
 *  - The [harness.pi.tiers] block wholly replaces the shared [tiers]:
 *    grok classifies to "frontier", minimax classifies to "fast".
 *  - parseConfig(sample, 'claude') is unaffected: yields the shared
 *    reviewers=["opus"], planners=["opus"], and opus classifies to "frontier".
 *
 * The inlined SAMPLE must match the documented commented block in cq.toml.example.
 */

import { describe, it, expect } from "bun:test";
import {
  parseConfig,
  parseReviewerToken,
  resolveReviewers,
  resolvePlanners,
  classifyToken,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Inlined sample — MUST match the commented [harness.pi] block in
// cq.toml.example (the documented example near the end of that file).
// The aliases (grok, minimax) are shared-only and remain in [aliases].
// ---------------------------------------------------------------------------
const HARNESS_PI_SAMPLE = `
reviewers = ["opus"]
planners  = ["opus"]

[aliases]
opus    = "claude:opus-4.8[1m]"
sonnet  = "claude:sonnet-4.6"
haiku   = "claude:haiku-4.5"
grok    = "pi:grok-build/grok-build"
minimax = "pi:ollama-cloud/minimax-m3"

[tiers]
opus    = "frontier"
sonnet  = "standard"
haiku   = "fast"

[harness.pi]
reviewers = ["grok", "minimax"]
planners  = ["grok"]

[harness.pi.tiers]
grok    = "frontier"
minimax = "fast"
`;

describe("cq-toml-harness-pi-sample — T484 documented example guard", () => {
  it("parseConfig(sample, 'pi') yields per-harness reviewers=[grok, minimax]", () => {
    const config = parseConfig(HARNESS_PI_SAMPLE, "pi");
    expect(config.reviewers).toEqual(["grok", "minimax"]);
  });

  it("parseConfig(sample, 'pi') yields per-harness planners=[grok]", () => {
    const config = parseConfig(HARNESS_PI_SAMPLE, "pi");
    expect(config.planners).toEqual(["grok"]);
  });

  it("resolveReviewers under 'pi' resolves grok and minimax through shared [aliases]", () => {
    const config = parseConfig(HARNESS_PI_SAMPLE, "pi");
    const tokens = resolveReviewers(config);
    expect(tokens).toEqual([
      parseReviewerToken("pi:grok-build/grok-build"),
      parseReviewerToken("pi:ollama-cloud/minimax-m3"),
    ]);
  });

  it("resolvePlanners under 'pi' resolves grok through shared [aliases]", () => {
    const config = parseConfig(HARNESS_PI_SAMPLE, "pi");
    const tokens = resolvePlanners(config);
    expect(tokens).toEqual([parseReviewerToken("pi:grok-build/grok-build")]);
  });

  it("[harness.pi.tiers] wholly replaces shared [tiers]: grok=frontier, minimax=fast", () => {
    const config = parseConfig(HARNESS_PI_SAMPLE, "pi");
    expect(config.tiers).not.toBeNull();
    const grokToken = parseReviewerToken("pi:grok-build/grok-build");
    const minimaxToken = parseReviewerToken("pi:ollama-cloud/minimax-m3");
    expect(classifyToken(config, grokToken)).toBe("frontier");
    expect(classifyToken(config, minimaxToken)).toBe("fast");
  });

  it("[harness.pi.tiers] REPLACES shared [tiers] — opus is not classified under pi", () => {
    // The shared [tiers] has opus=frontier, sonnet=standard, haiku=fast.
    // Under harness='pi' the per-harness [harness.pi.tiers] wholly replaces
    // those: the per-harness table only classifies grok and minimax, so
    // classifyToken returns undefined for the opus token (not in the pi table).
    const config = parseConfig(HARNESS_PI_SAMPLE, "pi");
    const opusToken = parseReviewerToken("claude:opus-4.8[1m]");
    expect(classifyToken(config, opusToken)).toBeUndefined();
  });

  it("parseConfig(sample, 'claude') keeps shared reviewers=[opus] unchanged", () => {
    const config = parseConfig(HARNESS_PI_SAMPLE, "claude");
    expect(config.reviewers).toEqual(["opus"]);
    expect(config.planners).toEqual(["opus"]);
  });

  it("parseConfig(sample, 'claude') keeps shared [tiers] — opus=frontier", () => {
    const config = parseConfig(HARNESS_PI_SAMPLE, "claude");
    expect(config.tiers).not.toBeNull();
    const opusToken = parseReviewerToken("claude:opus-4.8[1m]");
    expect(classifyToken(config, opusToken)).toBe("frontier");
  });

  it("resolveReviewers under 'claude' resolves to opus token only", () => {
    const config = parseConfig(HARNESS_PI_SAMPLE, "claude");
    const tokens = resolveReviewers(config);
    expect(tokens).toEqual([parseReviewerToken("claude:opus-4.8[1m]")]);
  });
});
