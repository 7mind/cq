/**
 * T477: layered harness-override merge in parseConfig / loadConfig (Q239/Q240).
 *
 * Acceptance cases:
 *  - with [harness.pi] reviewers/planners + [harness.pi.tiers] over shared
 *    [aliases] + top-level reviewers: parseConfig(src,'pi') yields the
 *    per-harness reviewers and a [tiers] classifier that classifies the
 *    per-harness token;
 *  - parseConfig(src,'claude') (and the default) yields the SHARED reviewers
 *    unchanged;
 *  - a flat cq.toml with NO [harness.*] parses identically under either harness;
 *  - a dangling alias in [harness.pi].reviewers throws CqConfigError ONLY when
 *    loaded with harness='pi' (the active-harness panel is validated eagerly).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  loadConfig,
  parseConfig,
  parseReviewerToken,
  resolveReviewers,
  tierModel,
  CqConfigError,
} from "../src/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cq-config-harness-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCqToml(contents: string): void {
  writeFileSync(path.join(dir, "cq.toml"), contents, "utf8");
}

const LAYERED_TOML = `
reviewers = ["opus"]
planners = ["opus"]

[aliases]
opus = "claude:opus-4.8[1m]"
grok = "pi:grok-build/grok-build"

[harness.pi]
reviewers = ["grok"]
planners = ["grok"]

[harness.pi.tiers]
standard = "grok"
`;

describe("parseConfig — layered [harness.<name>] override (T477)", () => {
  it("the active harness's block REPLACES shared reviewers/planners/tiers", () => {
    const pi = parseConfig(LAYERED_TOML, "pi");
    expect(pi.reviewers).toEqual(["grok"]);
    expect(pi.planners).toEqual(["grok"]);
    // resolveReviewers resolves the per-harness panel through the SHARED aliases.
    expect(resolveReviewers(pi)).toEqual([
      parseReviewerToken("pi:grok-build/grok-build"),
    ]);
    // The [harness.pi.tiers] override produced a real TiersConfig that
    // assigns the grok token to the "standard" tier.
    expect(pi.tiers).not.toBeNull();
    const grokToken = parseReviewerToken("pi:grok-build/grok-build");
    expect(tierModel(pi, "standard")).toEqual(grokToken);
  });

  it("a non-active harness (claude / default) keeps the SHARED reviewers unchanged", () => {
    const claude = parseConfig(LAYERED_TOML, "claude");
    expect(claude.reviewers).toEqual(["opus"]);
    expect(claude.planners).toEqual(["opus"]);
    // No shared [tiers] is declared, so it falls through to null under claude.
    expect(claude.tiers).toBeNull();

    // The default argument resolves to DEFAULT_HARNESS ("claude"), so an
    // omitted harness reproduces the pre-override behaviour.
    const dflt = parseConfig(LAYERED_TOML);
    expect(dflt.reviewers).toEqual(["opus"]);
    expect(dflt.planners).toEqual(["opus"]);
    expect(dflt.tiers).toBeNull();
  });

  it("a flat cq.toml with NO [harness.*] parses identically under either harness", () => {
    const flat = `
reviewers = ["opus", "grok"]
planners = ["opus"]

[aliases]
opus = "claude:opus-4.8[1m]"
grok = "pi:grok-build/grok-build"

[tiers]
frontier = "opus"
standard = "grok"
`;
    const underPi = parseConfig(flat, "pi");
    const underClaude = parseConfig(flat, "claude");
    expect(underPi).toEqual(underClaude);
    expect(underPi.reviewers).toEqual(["opus", "grok"]);
    expect(underPi.tiers).not.toBeNull();
  });
});

describe("loadConfig — eager validation of the ACTIVE harness panel (T477)", () => {
  const DANGLING_TOML = `
reviewers = ["opus"]
planners = ["opus"]

[aliases]
opus = "claude:opus-4.8[1m]"

[harness.pi]
reviewers = ["nonexistent"]
`;

  it("a dangling alias in [harness.pi].reviewers throws ONLY under harness='pi'", () => {
    writeCqToml(DANGLING_TOML);

    // Under the active harness 'pi', the merged reviewers = ["nonexistent"],
    // which has no alias -> eager resolveReviewers throws at load time.
    expect(() => loadConfig(dir, "pi")).toThrow(CqConfigError);

    // Under 'claude' the shared reviewers=["opus"] is intact, so load succeeds.
    const claude = loadConfig(dir, "claude");
    expect(claude).not.toBeNull();
    expect(claude!.reviewers).toEqual(["opus"]);
  });
});
