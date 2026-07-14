/**
 * T483: [ledger] and [webui] are SHARED-only sections — harness-invariant.
 *
 * Pins the guarantee that parseConfig / loadConfig never routes [ledger] or
 * [webui] through the per-harness override merge: even when a [harness.pi]
 * block is present (exercising the merge path), the returned config.ledger and
 * config.webui are IDENTICAL under "pi", "claude", and the DEFAULT_HARNESS.
 *
 * The TOML parser already rejects [harness.pi.ledger] and [harness.pi.webui]
 * as syntax errors (see toml-harness-overrides.test.ts). This test is the
 * parseConfig / CqConfig layer complement — it shows the SHARED path in the
 * config-merge code is never shadowed by a per-harness value, regardless of
 * the active harness.
 */

import { describe, it, expect } from "bun:test";
import { parseConfig } from "../src/index.js";

/**
 * A cq.toml that has BOTH a [ledger] table and a [webui] table at the
 * shared top level, plus a [harness.pi] override block that carries
 * reviewers/planners/tiers. This exercises the per-harness merge path
 * while leaving [ledger] and [webui] exclusively in the shared layer.
 */
const TOML_WITH_HARNESS_PI = `
reviewers = ["opus"]
planners  = ["opus"]

[aliases]
opus = "claude:opus-4.8[1m]"
grok = "pi:grok-build/grok-build"

[ledger]
backend = "git-object"
branch  = "cq-ledger"

[webui]
host = "0.0.0.0"
port = 6180

[harness.pi]
reviewers = ["grok"]
planners  = ["grok"]

[harness.pi.tiers]
standard = "grok"
`;

describe("[ledger] and [webui] are harness-invariant (T483)", () => {
  it("[ledger] is identical under harness=pi, harness=claude, and the default", () => {
    const underPi     = parseConfig(TOML_WITH_HARNESS_PI, "pi");
    const underClaude = parseConfig(TOML_WITH_HARNESS_PI, "claude");
    // Default harness (omitted arg) must equal claude.
    const underDefault = parseConfig(TOML_WITH_HARNESS_PI);

    expect(underPi.ledger).toEqual({
      backend: "git-object",
      branch: "cq-ledger",
      remote: "origin",
      backup: "none",
      projectId: null,
    });
    expect(underClaude.ledger).toEqual(underPi.ledger);
    expect(underDefault.ledger).toEqual(underPi.ledger);
  });

  it("[webui] is identical under harness=pi, harness=claude, and the default", () => {
    const underPi     = parseConfig(TOML_WITH_HARNESS_PI, "pi");
    const underClaude = parseConfig(TOML_WITH_HARNESS_PI, "claude");
    const underDefault = parseConfig(TOML_WITH_HARNESS_PI);

    expect(underPi.webui).toEqual({ host: "0.0.0.0", port: 6180 });
    expect(underClaude.webui).toEqual(underPi.webui);
    expect(underDefault.webui).toEqual(underPi.webui);
  });

  it("reviewers DO differ between pi and claude (confirms the override path is active)", () => {
    const underPi     = parseConfig(TOML_WITH_HARNESS_PI, "pi");
    const underClaude = parseConfig(TOML_WITH_HARNESS_PI, "claude");

    // Verifies the [harness.pi] block is actually being applied (it would be
    // a vacuous invariance test if the override path were never exercised).
    expect(underPi.reviewers).toEqual(["grok"]);
    expect(underClaude.reviewers).toEqual(["opus"]);
  });

  it("a flat cq.toml (no [harness.*]) yields equal [ledger]/[webui] under any harness", () => {
    const flat = `
[ledger]
backend = "fs"

[webui]
port = 5180
`;
    const pi    = parseConfig(flat, "pi");
    const claude = parseConfig(flat, "claude");

    expect(pi.ledger).toEqual(claude.ledger);
    expect(pi.webui).toEqual(claude.webui);
  });
});
