/**
 * T484: Regression guard for [harness.<name>] override MECHANICS in parseConfig
 * — per-harness reviewers/planners/tiers REPLACE (not merge with) the shared
 * top-level ones, and a selector with no override falls through unaffected.
 *
 * SUPERSEDED as a documentation-mirror guard (T864 round-1 review): this test
 * used to claim its inlined HARNESS_PI_SAMPLE "must match the documented
 * commented block in cq.toml.example" — but nothing enforced that claim
 * mechanically, and T864's edit to the documented block (cq.toml.example's
 * [harness.pi] moved from grok/minimax to the codex/terra/luna GPT-5.6 ladder)
 * proved the mirror could silently drift while this test kept passing.
 * `cq-toml-example.test.ts`'s "T864: the codex CONFIGURATION SELECTOR is
 * documented and schema-valid" describe block now owns doc-conformance for
 * real: it reads cq.toml.example from disk, extracts the LIVE documented
 * `[harness.pi]`/`[harness.codex]` commented block, uncomments it, and parses
 * it — so it fails the instant the documented block and its own assertions
 * diverge. That test supersedes this one for mirror/drift detection.
 *
 * HARNESS_PI_SAMPLE below is now an INDEPENDENT, self-contained fixture (no
 * longer claimed to mirror cq.toml.example) that exists solely to exercise the
 * override mechanics in isolation, with fixed, easy-to-reason-about tokens:
 *
 * Acceptance:
 *  - parseConfig(sample, 'pi') yields reviewers=["grok","minimax"],
 *    planners=["grok"] (per-harness panel, REPLACING the shared opus-only panel).
 *  - The [harness.pi.tiers] block wholly replaces the shared [tiers]:
 *    grok classifies to "frontier", minimax classifies to "fast".
 *  - parseConfig(sample, 'claude') is unaffected: yields the shared
 *    reviewers=["opus"], planners=["opus"], and opus classifies to "frontier".
 */

import { describe, it, expect } from "bun:test";
import {
  parseConfig,
  parseReviewerToken,
  resolveReviewers,
  resolvePlanners,
  tierModel,
  TIERS,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Inlined sample — an INDEPENDENT fixture for override mechanics, not a
// mirror of cq.toml.example (see file header: doc-conformance now lives in
// cq-toml-example.test.ts's T864 describe block).
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
frontier = "opus"
standard = "sonnet"
fast     = "haiku"

[harness.pi]
reviewers = ["grok", "minimax"]
planners  = ["grok"]

[harness.pi.tiers]
frontier = "grok"
fast     = "minimax"
`;

describe("cq-toml-harness-pi-sample — T484 [harness.<name>] override mechanics (independent fixture; superseded as a doc-mirror by cq-toml-example.test.ts's T864 block)", () => {
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

  it("[harness.pi.tiers] wholly replaces shared [tiers]: frontier=grok, fast=minimax", () => {
    const config = parseConfig(HARNESS_PI_SAMPLE, "pi");
    expect(config.tiers).not.toBeNull();
    const grokToken = parseReviewerToken("pi:grok-build/grok-build");
    const minimaxToken = parseReviewerToken("pi:ollama-cloud/minimax-m3");
    expect(tierModel(config, "frontier")).toEqual(grokToken);
    expect(tierModel(config, "fast")).toEqual(minimaxToken);
  });

  it("[harness.pi.tiers] REPLACES shared [tiers] — opus is not the model for any tier under pi", () => {
    // The shared [tiers] maps frontier=opus, standard=sonnet, fast=haiku.
    // Under harness='pi' the per-harness [harness.pi.tiers] wholly replaces
    // those: the per-harness table only names grok (frontier) and minimax
    // (fast), so no tier resolves to the opus token (and standard is unset).
    const config = parseConfig(HARNESS_PI_SAMPLE, "pi");
    const opusToken = parseReviewerToken("claude:opus-4.8[1m]");
    for (const tier of TIERS) {
      expect(tierModel(config, tier)).not.toEqual(opusToken);
    }
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
    expect(tierModel(config, "frontier")).toEqual(opusToken);
  });

  it("resolveReviewers under 'claude' resolves to opus token only", () => {
    const config = parseConfig(HARNESS_PI_SAMPLE, "claude");
    const tokens = resolveReviewers(config);
    expect(tokens).toEqual([parseReviewerToken("claude:opus-4.8[1m]")]);
  });
});
