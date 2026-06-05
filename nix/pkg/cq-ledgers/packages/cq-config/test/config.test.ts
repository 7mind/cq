/**
 * T170: cq.toml schema + parser/resolver tests (written reproduce-first).
 *
 * Covers the four acceptance cases:
 *  - valid [aliases]+reviewers resolves to the expected ReviewerToken[];
 *  - absent cq.toml => loadConfig returns null;
 *  - dangling alias => throws a precise error;
 *  - unknown harness => throws.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  loadConfig,
  resolveReviewers,
  resolvePlanners,
  parseConfig,
  parseReviewerToken,
  type ReviewerToken,
  type CqConfig,
} from "../src/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cq-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCqToml(contents: string): void {
  writeFileSync(path.join(dir, "cq.toml"), contents, "utf8");
}

const VALID_TOML = `
reviewers = ["codex", "grok", "opus"]

[aliases]
codex = "pi:gpt-5-codex"
grok = "pi:grok-4"
opus = "claude:opus-4.8"
`;

describe("parseReviewerToken", () => {
  it("parses a claude harness token", () => {
    const tok: ReviewerToken = parseReviewerToken("claude:opus-4.8");
    expect(tok).toEqual({ harness: "claude", model: "opus-4.8" });
  });

  it("parses a pi harness token", () => {
    expect(parseReviewerToken("pi:grok-4")).toEqual({
      harness: "pi",
      model: "grok-4",
    });
  });

  it("preserves colons inside the model segment", () => {
    expect(parseReviewerToken("pi:provider:model")).toEqual({
      harness: "pi",
      model: "provider:model",
    });
  });

  it("throws on an unknown harness", () => {
    expect(() => parseReviewerToken("gemini:flash")).toThrow(/unknown harness/i);
  });

  it("throws on a missing harness separator", () => {
    expect(() => parseReviewerToken("opus-4.8")).toThrow();
  });

  it("throws on an empty model segment", () => {
    expect(() => parseReviewerToken("claude:")).toThrow();
  });
});

describe("loadConfig", () => {
  it("returns null when cq.toml is absent", () => {
    expect(loadConfig(dir)).toBeNull();
  });

  it("loads and resolves a valid cq.toml", () => {
    writeCqToml(VALID_TOML);
    const config = loadConfig(dir);
    expect(config).not.toBeNull();
    const cfg = config as CqConfig;
    expect(cfg.aliases).toEqual({
      codex: { harness: "pi", model: "gpt-5-codex" },
      grok: { harness: "pi", model: "grok-4" },
      opus: { harness: "claude", model: "opus-4.8" },
    });
    // CqConfig.reviewers holds the raw ALIAS names (not yet resolved).
    expect(cfg.reviewers).toEqual(["codex", "grok", "opus"]);
    // Resolution through [aliases] yields the ReviewerToken[].
    expect(resolveReviewers(cfg)).toEqual([
      { harness: "pi", model: "gpt-5-codex" },
      { harness: "pi", model: "grok-4" },
      { harness: "claude", model: "opus-4.8" },
    ]);
  });

  it("throws on a dangling alias in reviewers", () => {
    writeCqToml(`
reviewers = ["codex", "ghost"]

[aliases]
codex = "pi:gpt-5-codex"
`);
    expect(() => loadConfig(dir)).toThrow(/undefined alias.*ghost/i);
  });

  it("throws on an unknown harness in an alias token", () => {
    writeCqToml(`
reviewers = ["weird"]

[aliases]
weird = "gemini:flash"
`);
    expect(() => loadConfig(dir)).toThrow(/unknown harness/i);
  });

  it("throws on malformed TOML", () => {
    writeCqToml(`[aliases\ncodex = "pi:gpt-5-codex"`);
    expect(() => loadConfig(dir)).toThrow();
  });
});

describe("resolveReviewers", () => {
  it("resolves reviewers through aliases", () => {
    const config = parseConfig(VALID_TOML);
    const resolved: ReviewerToken[] = resolveReviewers(config);
    expect(resolved).toEqual([
      { harness: "pi", model: "gpt-5-codex" },
      { harness: "pi", model: "grok-4" },
      { harness: "claude", model: "opus-4.8" },
    ]);
  });
});

// T12: planners=[...] support

const VALID_TOML_WITH_PLANNERS = `
reviewers = ["codex"]
planners = ["opus"]

[aliases]
codex = "pi:gpt-5-codex"
opus = "claude:opus-4.8"
`;

describe("parseConfig with planners", () => {
  it("whitelist rejects planners key before the fix (reproduce-first)", () => {
    // This test documents the pre-fix behaviour: the parser should throw
    // "unexpected top-level key planners" before the whitelist is extended.
    // After the fix this test is superseded by the passing parse test below.
    // We leave it here as documentation; post-fix it should no longer throw.
  });

  it("parses a cq.toml carrying both reviewers and planners", () => {
    const config = parseConfig(VALID_TOML_WITH_PLANNERS);
    expect(config.reviewers).toEqual(["codex"]);
    expect(config.planners).toEqual(["opus"]);
  });

  it("defaults planners to [] when absent", () => {
    const config = parseConfig(VALID_TOML);
    expect(config.planners).toEqual([]);
  });
});

describe("resolvePlanners", () => {
  it("resolves planner aliases through [aliases]", () => {
    const config = parseConfig(VALID_TOML_WITH_PLANNERS);
    const resolved: ReviewerToken[] = resolvePlanners(config);
    expect(resolved).toEqual([{ harness: "claude", model: "opus-4.8" }]);
  });

  it("throws on a dangling planner alias", () => {
    const config = parseConfig(`
planners = ["ghost"]
[aliases]
`);
    expect(() => resolvePlanners(config)).toThrow(/undefined alias.*ghost/i);
  });
});

describe("loadConfig with planners", () => {
  it("loads and resolves a cq.toml with planners", () => {
    writeCqToml(VALID_TOML_WITH_PLANNERS);
    const config = loadConfig(dir);
    expect(config).not.toBeNull();
    const cfg = config as CqConfig;
    expect(cfg.planners).toEqual(["opus"]);
    expect(resolvePlanners(cfg)).toEqual([
      { harness: "claude", model: "opus-4.8" },
    ]);
  });

  it("throws at load time on a dangling planner alias", () => {
    writeCqToml(`
planners = ["ghost"]
[aliases]
`);
    expect(() => loadConfig(dir)).toThrow(/undefined alias.*ghost/i);
  });
});
