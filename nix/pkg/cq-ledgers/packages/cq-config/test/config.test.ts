/**
 * T170: cq.toml schema + parser/resolver tests (written reproduce-first).
 * T223: [tiers] + [agent_tiers] additive tables.
 *
 * Covers the four acceptance cases:
 *  - valid [aliases]+reviewers resolves to the expected ReviewerToken[];
 *  - absent cq.toml => loadConfig returns null;
 *  - dangling alias => throws a precise error;
 *  - unknown harness => throws.
 *
 * T223 acceptance cases (a–d):
 *  (a) [tiers] parses fast/standard/frontier into a resolved provider+model;
 *  (b) [agent_tiers] parses agent-name->tier; unlisted agent resolves to DEFAULT_TIER;
 *  (c) named agent resolves end-to-end: agent-name -> tier -> provider+model;
 *  (d) cq.toml WITHOUT either new table still yields configured:true with the
 *      existing aliases/reviewers/planners intact.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  loadConfig,
  resolveReviewers,
  resolvePlanners,
  resolveAgentTier,
  classifyToken,
  selectTokensForTier,
  resolveAgentModel,
  parseConfig,
  parseReviewerToken,
  reviewerTokensEqual,
  CqConfigError,
  DEFAULT_TIER,
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
codex = "pi:grok-build/grok-build"
grok = "pi:grok-build/grok-build"
opus = "claude:opus-4.8"
`;

describe("parseReviewerToken", () => {
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

// T231: provider qualifier grammar (BREAKING — bare pi is rejected).
describe("parseReviewerToken — provider qualifier (T231)", () => {
  it("splits a pi token into provider + model on the first '/'", () => {
    const tok: ReviewerToken = parseReviewerToken("pi:ollama-cloud/minimax-m3");
    expect(tok).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
      effort: null,
    });
  });

  it("parses a claude token with provider null", () => {
    const tok: ReviewerToken = parseReviewerToken("claude:opus-4.8[1m]");
    expect(tok).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
  });

  it("rejects a bare pi token (no provider qualifier)", () => {
    expect(() => parseReviewerToken("pi:minimax-m3")).toThrow(CqConfigError);
  });

  it("rejects a provider qualifier on a claude token", () => {
    expect(() => parseReviewerToken("claude:x/y")).toThrow(CqConfigError);
  });

  it("rejects a pi token with an empty provider half", () => {
    expect(() => parseReviewerToken("pi:/m")).toThrow(CqConfigError);
  });

  it("rejects a pi token with an empty model half", () => {
    expect(() => parseReviewerToken("pi:p/")).toThrow(CqConfigError);
  });

  it("rejects a reserved ':' inside the pi model segment (pi:prov/a:b)", () => {
    // T286/R342: `:` is reserved inside the pi model half. `b` is not a pi
    // effort, so the trailing-':' suffix is rejected (no longer preserved).
    expect(() => parseReviewerToken("pi:prov/a:b")).toThrow(CqConfigError);
  });
});

// T286 (Q160 + R342): optional trailing `:<effort>` suffix; `:` reserved in
// the residual model on BOTH the claude model and the pi model half.
describe("parseReviewerToken — effort suffix (T286)", () => {
  it("parses a pi token with a valid trailing effort", () => {
    const tok: ReviewerToken = parseReviewerToken("pi:grok-build/grok-build:xhigh");
    expect(tok).toEqual({
      harness: "pi",
      provider: "grok-build",
      model: "grok-build",
      effort: "xhigh",
    });
  });

  it("parses a claude token with a bracket model AND a valid trailing effort", () => {
    const tok: ReviewerToken = parseReviewerToken("claude:opus-4.8[1m]:high");
    expect(tok).toEqual({
      harness: "claude",
      provider: null,
      model: "opus-4.8[1m]",
      effort: "high",
    });
  });

  it("sets effort:null when a claude bracket model has no trailing suffix", () => {
    const tok: ReviewerToken = parseReviewerToken("claude:opus-4.8[1m]");
    expect(tok).toEqual({
      harness: "claude",
      provider: null,
      model: "opus-4.8[1m]",
      effort: null,
    });
  });

  it("sets effort:null when a pi token has no trailing suffix", () => {
    const tok: ReviewerToken = parseReviewerToken("pi:ollama-cloud/minimax-m3");
    expect(tok).toEqual({
      harness: "pi",
      provider: "ollama-cloud",
      model: "minimax-m3",
      effort: null,
    });
  });

  it("rejects a claude effort not in the claude enum (claude:opus:off)", () => {
    // `off` is a pi effort, not a claude effort → fail fast naming the set.
    expect(() => parseReviewerToken("claude:opus:off")).toThrow(CqConfigError);
    expect(() => parseReviewerToken("claude:opus:off")).toThrow(/off/);
    expect(() => parseReviewerToken("claude:opus:off")).toThrow(/max/);
  });

  it("rejects a pi effort not in the pi enum (pi:p/m:max)", () => {
    // `max` is a claude effort, not a pi effort.
    expect(() => parseReviewerToken("pi:p/m:max")).toThrow(CqConfigError);
    expect(() => parseReviewerToken("pi:p/m:max")).toThrow(/max/);
    expect(() => parseReviewerToken("pi:p/m:max")).toThrow(/xhigh/);
  });

  it("rejects a bogus claude effort (claude:opus:bogus)", () => {
    expect(() => parseReviewerToken("claude:opus:bogus")).toThrow(CqConfigError);
    expect(() => parseReviewerToken("claude:opus:bogus")).toThrow(/bogus/);
  });

  it("rejects a claude model with a stray reserved ':' that is not an effort", () => {
    // `claude:a:b:high` → last ':' splits valid effort 'high', residual model
    // 'a:b' still contains a reserved ':' → R342 reject.
    expect(() => parseReviewerToken("claude:a:b:high")).toThrow(CqConfigError);
  });

  it("rejects a pi token whose trailing suffix is not a valid effort (pi:prov/mo:del)", () => {
    // `del` is the last-colon candidate; isEffort('pi','del') is false, so this
    // rejects via the "invalid effort suffix" path naming `del` + the legal pi
    // effort set — NOT the R342 model-half residual-':' path (after stripping a
    // hypothetical effort, 'prov/mo' has no residual ':'). See the next test
    // for the R342 path.
    expect(() => parseReviewerToken("pi:prov/mo:del")).toThrow(CqConfigError);
    expect(() => parseReviewerToken("pi:prov/mo:del")).toThrow(/del/);
  });

  it("rejects a pi model half with a reserved ':' even when a valid effort follows (R342)", () => {
    // `pi:prov/m:o:high` → last-colon candidate 'high' IS a valid pi effort, so
    // it is stripped; residual model half is 'prov/m:o' → model 'm:o' still
    // contains a reserved ':' → R342 reject. The error names the residual model,
    // distinguishing this path from the invalid-effort-suffix path above.
    expect(() => parseReviewerToken("pi:prov/m:o:high")).toThrow(CqConfigError);
    expect(() => parseReviewerToken("pi:prov/m:o:high")).toThrow(/reserved ':'/);
    expect(() => parseReviewerToken("pi:prov/m:o:high")).toThrow(/m:o/);
  });
});

// T290 (Q162): effort PARTICIPATES in token identity. reviewerTokensEqual must
// distinguish two tokens that differ ONLY in their effort suffix, while two
// parses of the SAME effort (and two effortless parses) still compare equal.
describe("reviewerTokensEqual — effort participates in identity (T290)", () => {
  it("returns false for the same model at different efforts (high vs low)", () => {
    expect(
      reviewerTokensEqual(
        parseReviewerToken("claude:opus-4.8[1m]:high"),
        parseReviewerToken("claude:opus-4.8[1m]:low"),
      ),
    ).toBe(false);
  });

  it("returns true for two parses of the same effortful token (high == high)", () => {
    expect(
      reviewerTokensEqual(
        parseReviewerToken("claude:opus-4.8[1m]:high"),
        parseReviewerToken("claude:opus-4.8[1m]:high"),
      ),
    ).toBe(true);
  });

  it("returns true for two parses of the same effortless token", () => {
    expect(
      reviewerTokensEqual(
        parseReviewerToken("claude:opus-4.8[1m]"),
        parseReviewerToken("claude:opus-4.8[1m]"),
      ),
    ).toBe(true);
  });

  it("treats omitted (undefined) and explicit null effort as the same class", () => {
    // A token parsed without a suffix carries effort:null; an object that omits
    // the field entirely (effort:undefined) must compare equal to it.
    const parsed = parseReviewerToken("claude:opus-4.8[1m]");
    const omitted: ReviewerToken = {
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
    };
    expect(reviewerTokensEqual(parsed, omitted)).toBe(true);
    expect(reviewerTokensEqual(omitted, parsed)).toBe(true);
  });

  it("returns false for an effortful token vs the same effortless token", () => {
    expect(
      reviewerTokensEqual(
        parseReviewerToken("claude:opus-4.8[1m]:high"),
        parseReviewerToken("claude:opus-4.8[1m]"),
      ),
    ).toBe(false);
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
      codex: { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
      grok: { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
      opus: { harness: "claude", model: "opus-4.8", provider: null, effort: null },
    });
    // CqConfig.reviewers holds the raw ALIAS names (not yet resolved).
    expect(cfg.reviewers).toEqual(["codex", "grok", "opus"]);
    // Resolution through [aliases] yields the ReviewerToken[].
    expect(resolveReviewers(cfg)).toEqual([
      { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
      { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
      { harness: "claude", model: "opus-4.8", provider: null, effort: null },
    ]);
  });

  it("throws on a dangling alias in reviewers", () => {
    writeCqToml(`
reviewers = ["codex", "ghost"]

[aliases]
codex = "pi:grok-build/grok-build"
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
    writeCqToml(`[aliases\ncodex = "pi:grok-build/grok-build"`);
    expect(() => loadConfig(dir)).toThrow();
  });
});

describe("resolveReviewers", () => {
  it("resolves reviewers through aliases", () => {
    const config = parseConfig(VALID_TOML);
    const resolved: ReviewerToken[] = resolveReviewers(config);
    expect(resolved).toEqual([
      { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
      { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
      { harness: "claude", model: "opus-4.8", provider: null, effort: null },
    ]);
  });
});

// T12: planners=[...] support

const VALID_TOML_WITH_PLANNERS = `
reviewers = ["codex"]
planners = ["opus"]

[aliases]
codex = "pi:grok-build/grok-build"
opus = "claude:opus-4.8"
`;

describe("parseConfig with planners", () => {
  it("whitelist rejects an unknown top-level key but accepts planners", () => {
    // (a) Unknown top-level key hits the same rejection path that `planners`
    //     hit before the whitelist was extended — verifies the guard is live.
    expect(() => parseConfig(`bogus = []\n`)).toThrow(
      /unexpected top-level key bogus/,
    );
    // (b) After the fix, `planners` is whitelisted — must parse without error.
    expect(() => parseConfig(VALID_TOML_WITH_PLANNERS)).not.toThrow();
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
    expect(resolved).toEqual([
      { harness: "claude", model: "opus-4.8", provider: null, effort: null },
    ]);
  });

  it("throws on a dangling planner alias", () => {
    const config = parseConfig(`
planners = ["ghost"]
[aliases]
`);
    expect(() => resolvePlanners(config)).toThrow(/undefined alias.*ghost/i);
  });
});

// T185: smol-toml swap + typed [webui] table (host string + integer port).

const VALID_TOML_WITH_WEBUI = `
reviewers = ["codex"]

[aliases]
codex = "pi:grok-build/grok-build"

[webui]
host = "0.0.0.0"
port = 5180
`;

describe("parseConfig with [webui]", () => {
  it("parses host + integer port, port stays a number", () => {
    const config = parseConfig(VALID_TOML_WITH_WEBUI);
    expect(config.webui).toEqual({ host: "0.0.0.0", port: 5180 });
    expect(typeof config.webui?.port).toBe("number");
  });

  it("defaults webui to null when absent", () => {
    expect(parseConfig(VALID_TOML).webui).toBeNull();
  });

  it("allows a [webui] table with only host", () => {
    expect(parseConfig(`[webui]\nhost = "127.0.0.1"\n`).webui).toEqual({
      host: "127.0.0.1",
      port: null,
    });
  });

  it("allows a [webui] table with only port", () => {
    expect(parseConfig(`[webui]\nport = 8080\n`).webui).toEqual({
      host: null,
      port: 8080,
    });
  });

  it("throws on an unknown key inside [webui]", () => {
    expect(() => parseConfig(`[webui]\nbogus = 1\n`)).toThrow(
      /unexpected key "bogus" in \[webui\]/,
    );
  });

  it("throws CqConfigError on a string port", () => {
    expect(() => parseConfig(`[webui]\nport = "5180"\n`)).toThrow(
      CqConfigError,
    );
  });

  it("throws CqConfigError on a non-integer port", () => {
    expect(() => parseConfig(`[webui]\nport = 5180.5\n`)).toThrow(
      CqConfigError,
    );
  });

  it("throws CqConfigError on an out-of-range port", () => {
    expect(() => parseConfig(`[webui]\nport = 0\n`)).toThrow(CqConfigError);
    expect(() => parseConfig(`[webui]\nport = 70000\n`)).toThrow(
      CqConfigError,
    );
  });

  it("throws CqConfigError on a non-string host", () => {
    expect(() => parseConfig(`[webui]\nhost = 123\n`)).toThrow(CqConfigError);
  });
});

describe("whitelist over smol-toml output", () => {
  it("rejects an unknown top-level table", () => {
    expect(() => parseConfig(`[bogus]\nx = 1\n`)).toThrow(
      /unexpected top-level key bogus/,
    );
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseConfig(`bogus = []\n`)).toThrow(
      /unexpected top-level key bogus/,
    );
  });

  it("still throws on malformed TOML (wrapped TomlError)", () => {
    expect(() => parseConfig(`[aliases\ncodex = "pi:x"`)).toThrow();
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
      { harness: "claude", model: "opus-4.8", provider: null, effort: null },
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

// T223: [tiers] + [agent_tiers] additive tables.

const VALID_TOML_WITH_TIERS = `
reviewers = ["opus"]
planners = ["opus"]

[aliases]
opus = "claude:opus-4.8[1m]"
minimax = "pi:ollama-cloud/minimax-m3"
grok = "pi:grok-build/grok-build"

[tiers]
"pi:ollama-cloud/minimax-m3" = "fast"
grok = "standard"
opus = "frontier"

[agent_tiers]
investigate-explorer = "frontier"
plan-reviewer = "frontier"
implement-worker = "standard"
implement-reviewer = "standard"
`;

describe("parseConfig with [tiers] (T223 acceptance a)", () => {
  it("parses fast/standard/frontier into resolved ReviewerTokens (direct token)", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    expect(config.tiers).not.toBeNull();
    // T268 minimal bridge: TiersConfig is now the inverted classifier
    // (`entries`). Read the token classified as `fast` via the entries list.
    // 'fast' is a direct "<harness>:<model>" token (not an alias).
    const fastEntry = config.tiers!.entries.find((e) => e.class === "fast");
    expect(fastEntry?.token).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
      effort: null,
    });
  });

  it("resolves a tier value that names an alias", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    // 'standard' = "grok" — a name in [aliases] -> pi:grok-build/grok-build
    const standardEntry = config.tiers!.entries.find(
      (e) => e.class === "standard",
    );
    expect(standardEntry?.token).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
      effort: null,
    });
    // 'frontier' = "opus" — a name in [aliases] -> claude:opus-4.8[1m]
    const frontierEntry = config.tiers!.entries.find(
      (e) => e.class === "frontier",
    );
    expect(frontierEntry?.token).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
  });

  it("defaults tiers to null when [tiers] is absent", () => {
    const config = parseConfig(VALID_TOML);
    expect(config.tiers).toBeNull();
  });

  it("throws on a non-tier VALUE in [tiers]", () => {
    // T270 inverted keying: KEY is a token/alias, VALUE is the tier class.
    // "ultra" is not a valid tier class.
    expect(() =>
      parseConfig(`
[tiers]
"claude:opus-4.8[1m]" = "ultra"
`),
    ).toThrow(/is not a valid tier class/i);
  });

  it("throws on a token KEY with an unknown harness", () => {
    // T270 inverted keying: the KEY is the token; an unknown harness in the
    // key surfaces parseReviewerToken's precise error.
    expect(() =>
      parseConfig(`
[tiers]
"gemini:flash" = "fast"
`),
    ).toThrow(/unknown harness/i);
  });
});

describe("parseConfig with [agent_tiers] (T223 acceptance b)", () => {
  it("parses agent-name -> tier map", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    expect(config.agentTiers).not.toBeNull();
    expect(config.agentTiers!["investigate-explorer"]).toBe("frontier");
    expect(config.agentTiers!["implement-worker"]).toBe("standard");
  });

  it("an unlisted agent resolves to DEFAULT_TIER via resolveAgentTier", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    const tier = resolveAgentTier(config, "unknown-agent");
    expect(tier).toBe(DEFAULT_TIER);
  });

  it("a listed agent resolves to its configured tier", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    expect(resolveAgentTier(config, "investigate-explorer")).toBe("frontier");
    expect(resolveAgentTier(config, "implement-worker")).toBe("standard");
  });

  it("resolveAgentTier falls back to DEFAULT_TIER when [agent_tiers] is absent", () => {
    const config = parseConfig(VALID_TOML);
    expect(config.agentTiers).toBeNull();
    expect(resolveAgentTier(config, "any-agent")).toBe(DEFAULT_TIER);
  });

  it("defaults agentTiers to null when [agent_tiers] is absent", () => {
    const config = parseConfig(VALID_TOML);
    expect(config.agentTiers).toBeNull();
  });

  it("throws on an invalid tier value in [agent_tiers]", () => {
    expect(() =>
      parseConfig(`
[agent_tiers]
my-agent = "ultra"
`),
    ).toThrow(/not a valid tier/i);
  });
});

describe("resolveAgentModel end-to-end (T223 acceptance c; T271 classifier)", () => {
  // The active candidate set for these fixtures: all three aliased tokens.
  // resolveAgentModel filters them by the agent's classified tier.
  const ALL_TOKENS: ReviewerToken[] = [
    { harness: "claude", model: "opus-4.8[1m]", provider: null }, // frontier
    { harness: "pi", model: "minimax-m3", provider: "ollama-cloud" }, // fast
    { harness: "pi", model: "grok-build", provider: "grok-build" }, // standard
  ];

  it("resolves agent-name -> tier -> first classified candidate", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    // investigate-explorer -> frontier -> only opus classifies as frontier
    expect(resolveAgentModel(config, "investigate-explorer", ALL_TOKENS)).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
    });
    // implement-worker -> standard. After T282 the [tiers] fixture is
    // contradiction-free: `grok` (alias -> pi:grok-build/grok-build) is the
    // standard token, so the standard candidate resolves unambiguously.
    expect(resolveAgentModel(config, "implement-worker", ALL_TOKENS)).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
    });
  });

  it("resolves an unlisted agent to the DEFAULT_TIER (standard) candidate", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    // unlisted agent -> standard (DEFAULT_TIER); grok-build is the standard
    // token, so resolveAgentModel returns it.
    expect(resolveAgentModel(config, "unlisted-agent", ALL_TOKENS)).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
    });
  });

  it("throws when [tiers] is absent (nothing classifies)", () => {
    const config = parseConfig(VALID_TOML);
    expect(() =>
      resolveAgentModel(config, "any-agent", ALL_TOKENS),
    ).toThrow(CqConfigError);
  });

  it("classifyToken returns the configured class or undefined", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    expect(
      classifyToken(config, {
        harness: "claude",
        model: "opus-4.8[1m]",
        provider: null,
      }),
    ).toBe("frontier");
    expect(
      classifyToken(config, {
        harness: "pi",
        model: "grok-build",
        provider: "grok-build",
      }),
    ).toBe("standard");
  });

  it("classifyToken returns undefined when [tiers] is absent", () => {
    const config = parseConfig(VALID_TOML);
    expect(
      classifyToken(config, {
        harness: "claude",
        model: "opus-4.8",
        provider: null,
      }),
    ).toBeUndefined();
  });

  it("selectTokensForTier preserves candidate order and drops non-matches", () => {
    const config = parseConfig(`
[tiers]
"claude:a" = "frontier"
"claude:b" = "frontier"
"claude:c" = "fast"
`);
    const candidates: ReviewerToken[] = [
      { harness: "claude", model: "b", provider: null },
      { harness: "claude", model: "c", provider: null },
      { harness: "claude", model: "a", provider: null },
    ];
    // Order follows CANDIDATES (b before a), not [tiers] declaration order.
    expect(selectTokensForTier(config, "frontier", candidates)).toEqual([
      { harness: "claude", model: "b", provider: null },
      { harness: "claude", model: "a", provider: null },
    ]);
  });
});

describe("additive-only regression (T223 acceptance d)", () => {
  it("cq.toml WITHOUT [tiers]/[agent_tiers] still yields configured:true with existing config intact", () => {
    const config = parseConfig(VALID_TOML);
    // existing fields intact
    expect(config.aliases).toEqual({
      codex: { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
      grok: { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
      opus: { harness: "claude", model: "opus-4.8", provider: null, effort: null },
    });
    expect(config.reviewers).toEqual(["codex", "grok", "opus"]);
    expect(config.planners).toEqual([]);
    // new fields are null (not present)
    expect(config.tiers).toBeNull();
    expect(config.agentTiers).toBeNull();
    // resolveReviewers still works
    expect(resolveReviewers(config)).toEqual([
      { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
      { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
      { harness: "claude", model: "opus-4.8", provider: null, effort: null },
    ]);
  });

  it("whitelist still rejects unknown top-level keys", () => {
    expect(() => parseConfig(`[bogus]\nx = 1\n`)).toThrow(
      /unexpected top-level key bogus/,
    );
  });
});

// ── T273: Inverted [tiers] classifier grammar — comprehensive coverage ────────
//
// Fixture: one [tiers] table with all three key forms:
//  (a) a direct claude:<model> key  ("claude:haiku-4.5" = "fast")
//  (b) a direct pi:<provider>/<model> key  ("pi:grok-build/grok-build" = "standard")
//  (c) an alias key  (haiku = …; haiku = "frontier")
//  Each token appears exactly once (no D42 contradictory-config scenario).

const TIERS_TOML = `
reviewers = ["haiku", "fast-claude"]
planners  = ["fast-pi", "haiku"]

[aliases]
haiku      = "claude:haiku-4.5"
fast-pi    = "pi:grok-build/grok-build"
fast-claude = "claude:sonnet-4.5"

[tiers]
"claude:haiku-4.5"           = "frontier"
"pi:grok-build/grok-build"   = "standard"
"claude:sonnet-4.5"          = "fast"
`;

describe("T273 — inverted [tiers] classifier grammar: token-keyed parse", () => {
  it("parses a direct claude:<model> key", () => {
    const config = parseConfig(TIERS_TOML);
    expect(config.tiers).not.toBeNull();
    const entry = config.tiers!.entries.find(
      (e) =>
        e.token.harness === "claude" && e.token.model === "haiku-4.5",
    );
    expect(entry).toBeDefined();
    expect(entry!.token).toEqual({
      harness: "claude",
      model: "haiku-4.5",
      provider: null,
      effort: null,
    });
    expect(entry!.raw).toBe("claude:haiku-4.5");
    expect(entry!.class).toBe("frontier");
  });

  it("parses a direct pi:<provider>/<model> key", () => {
    const config = parseConfig(TIERS_TOML);
    const entry = config.tiers!.entries.find(
      (e) =>
        e.token.harness === "pi" && e.token.model === "grok-build",
    );
    expect(entry).toBeDefined();
    expect(entry!.token).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
      effort: null,
    });
    expect(entry!.raw).toBe("pi:grok-build/grok-build");
    expect(entry!.class).toBe("standard");
  });

  it("parses \"claude:haiku-4.5\" = \"fast\" in isolation", () => {
    const config = parseConfig(`
[tiers]
"claude:haiku-4.5" = "fast"
`);
    expect(config.tiers).not.toBeNull();
    expect(config.tiers!.entries).toHaveLength(1);
    const entry = config.tiers!.entries[0]!;
    expect(entry.token).toEqual({
      harness: "claude",
      model: "haiku-4.5",
      provider: null,
      effort: null,
    });
    expect(entry.raw).toBe("claude:haiku-4.5");
    expect(entry.class).toBe("fast");
  });

  it("parses an alias key (resolves through [aliases])", () => {
    const config = parseConfig(`
[aliases]
opus = "claude:opus-4.8[1m]"

[tiers]
opus = "frontier"
`);
    expect(config.tiers).not.toBeNull();
    const entry = config.tiers!.entries[0]!;
    expect(entry.token).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
    expect(entry.raw).toBe("opus");
    expect(entry.class).toBe("frontier");
  });

  it("entries array contains all three key forms from TIERS_TOML", () => {
    const config = parseConfig(TIERS_TOML);
    expect(config.tiers!.entries).toHaveLength(3);
    // All three tokens represented:
    const harnesses = config.tiers!.entries.map((e) => e.token.harness);
    expect(harnesses.filter((h) => h === "claude")).toHaveLength(2);
    expect(harnesses.filter((h) => h === "pi")).toHaveLength(1);
  });
});

describe("T273 — classifyToken: correct class + undefined for unclassified", () => {
  it("classifyToken returns 'frontier' for claude:haiku-4.5 (direct claude key)", () => {
    const config = parseConfig(TIERS_TOML);
    expect(
      classifyToken(config, {
        harness: "claude",
        model: "haiku-4.5",
        provider: null,
      }),
    ).toBe("frontier");
  });

  it("classifyToken returns 'standard' for pi:grok-build/grok-build (direct pi key)", () => {
    const config = parseConfig(TIERS_TOML);
    expect(
      classifyToken(config, {
        harness: "pi",
        model: "grok-build",
        provider: "grok-build",
      }),
    ).toBe("standard");
  });

  it("classifyToken returns 'fast' for claude:sonnet-4.5 (alias-key entry)", () => {
    const config = parseConfig(TIERS_TOML);
    expect(
      classifyToken(config, {
        harness: "claude",
        model: "sonnet-4.5",
        provider: null,
      }),
    ).toBe("fast");
  });

  it("classifyToken returns undefined for a token not in [tiers]", () => {
    const config = parseConfig(TIERS_TOML);
    // pi:ollama-cloud/minimax-m3 is not listed in TIERS_TOML
    expect(
      classifyToken(config, {
        harness: "pi",
        model: "minimax-m3",
        provider: "ollama-cloud",
      }),
    ).toBeUndefined();
  });

  it("classifyToken returns undefined when [tiers] is absent", () => {
    const config = parseConfig(VALID_TOML);
    expect(
      classifyToken(config, {
        harness: "claude",
        model: "opus-4.8",
        provider: null,
      }),
    ).toBeUndefined();
  });

  it("classifyToken uses structural equality — model mismatch yields undefined", () => {
    const config = parseConfig(TIERS_TOML);
    // "claude:haiku-4.5" is in [tiers]; "claude:haiku-4.6" is not
    expect(
      classifyToken(config, {
        harness: "claude",
        model: "haiku-4.6",
        provider: null,
      }),
    ).toBeUndefined();
  });

  it("classifyToken uses structural equality — provider mismatch yields undefined", () => {
    const config = parseConfig(TIERS_TOML);
    // pi:grok-build/grok-build is classified; pi:other/grok-build is not
    expect(
      classifyToken(config, {
        harness: "pi",
        model: "grok-build",
        provider: "other",
      }),
    ).toBeUndefined();
  });
});

describe("T273 — selectTokensForTier: tie-break order (candidate order)", () => {
  it("returns class-matching candidates in candidate order, not [tiers] declaration order", () => {
    const config = parseConfig(`
[tiers]
"claude:a" = "frontier"
"claude:b" = "frontier"
"claude:c" = "fast"
`);
    const candidates: ReviewerToken[] = [
      { harness: "claude", model: "b", provider: null },
      { harness: "claude", model: "c", provider: null },
      { harness: "claude", model: "a", provider: null },
    ];
    // b appears before a in candidates → b first in result even though a is
    // declared first in [tiers]
    expect(selectTokensForTier(config, "frontier", candidates)).toEqual([
      { harness: "claude", model: "b", provider: null },
      { harness: "claude", model: "a", provider: null },
    ]);
  });

  it("returns only candidates matching the requested tier", () => {
    const config = parseConfig(TIERS_TOML);
    const candidates: ReviewerToken[] = [
      { harness: "claude", model: "haiku-4.5", provider: null },   // frontier
      { harness: "pi", model: "grok-build", provider: "grok-build" }, // standard
      { harness: "claude", model: "sonnet-4.5", provider: null },  // fast
    ];
    expect(selectTokensForTier(config, "standard", candidates)).toEqual([
      { harness: "pi", model: "grok-build", provider: "grok-build" },
    ]);
    expect(selectTokensForTier(config, "fast", candidates)).toEqual([
      { harness: "claude", model: "sonnet-4.5", provider: null },
    ]);
    expect(selectTokensForTier(config, "frontier", candidates)).toEqual([
      { harness: "claude", model: "haiku-4.5", provider: null },
    ]);
  });

  it("returns empty array when no candidate matches the tier", () => {
    const config = parseConfig(TIERS_TOML);
    const candidates: ReviewerToken[] = [
      { harness: "pi", model: "minimax-m3", provider: "ollama-cloud" }, // unclassified
    ];
    expect(selectTokensForTier(config, "fast", candidates)).toEqual([]);
  });

  it("returns empty array when [tiers] is absent", () => {
    const config = parseConfig(VALID_TOML);
    const candidates: ReviewerToken[] = [
      { harness: "claude", model: "opus-4.8", provider: null },
    ];
    expect(selectTokensForTier(config, "frontier", candidates)).toEqual([]);
  });

  it("preserves duplicates in candidate list (no deduplication)", () => {
    const config = parseConfig(`[tiers]\n"claude:a" = "fast"\n`);
    const token: ReviewerToken = { harness: "claude", model: "a", provider: null };
    // Duplicate in candidates is preserved as-is
    expect(selectTokensForTier(config, "fast", [token, token])).toEqual([
      token,
      token,
    ]);
  });
});

describe("T273 — resolveAgentModel: end-to-end + no-match throw", () => {
  // Unambiguous fixture: each token appears in [tiers] exactly once.
  const CLEAN_TOML = `
reviewers = ["haiku", "sonnet", "mini"]
planners  = ["haiku"]

[aliases]
haiku  = "claude:haiku-4.5"
sonnet = "claude:sonnet-4.5"
mini   = "pi:ollama-cloud/minimax-m3"

[tiers]
"claude:haiku-4.5"         = "fast"
"claude:sonnet-4.5"        = "standard"
"pi:ollama-cloud/minimax-m3" = "frontier"

[agent_tiers]
fast-agent     = "fast"
standard-agent = "standard"
frontier-agent = "frontier"
`;

  const CANDIDATES: ReviewerToken[] = [
    { harness: "claude", model: "haiku-4.5", provider: null },
    { harness: "claude", model: "sonnet-4.5", provider: null },
    { harness: "pi", model: "minimax-m3", provider: "ollama-cloud" },
  ];

  it("resolves fast-agent -> fast -> claude:haiku-4.5", () => {
    const config = parseConfig(CLEAN_TOML);
    expect(resolveAgentModel(config, "fast-agent", CANDIDATES)).toEqual({
      harness: "claude",
      model: "haiku-4.5",
      provider: null,
    });
  });

  it("resolves standard-agent -> standard -> claude:sonnet-4.5", () => {
    const config = parseConfig(CLEAN_TOML);
    expect(resolveAgentModel(config, "standard-agent", CANDIDATES)).toEqual({
      harness: "claude",
      model: "sonnet-4.5",
      provider: null,
    });
  });

  it("resolves frontier-agent -> frontier -> pi:ollama-cloud/minimax-m3", () => {
    const config = parseConfig(CLEAN_TOML);
    expect(resolveAgentModel(config, "frontier-agent", CANDIDATES)).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
    });
  });

  it("unlisted agent falls back to DEFAULT_TIER ('standard') and resolves", () => {
    const config = parseConfig(CLEAN_TOML);
    expect(resolveAgentModel(config, "unknown-agent", CANDIDATES)).toEqual({
      harness: "claude",
      model: "sonnet-4.5",
      provider: null,
    });
  });

  it("throws CqConfigError with the exact message when no candidate classifies to the tier", () => {
    const config = parseConfig(CLEAN_TOML);
    const noFastCandidates: ReviewerToken[] = [
      { harness: "claude", model: "sonnet-4.5", provider: null },
      { harness: "pi", model: "minimax-m3", provider: "ollama-cloud" },
    ];
    let caught: unknown;
    try {
      resolveAgentModel(config, "fast-agent", noFastCandidates);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toBe(
      'cq.toml: cannot resolve a model for agent "fast-agent": no active token classifies as tier "fast" in [tiers] (candidates: claude:sonnet-4.5, pi:ollama-cloud/minimax-m3)',
    );
  });

  it("throws CqConfigError with the exact message when candidates list is empty", () => {
    const config = parseConfig(CLEAN_TOML);
    let caught: unknown;
    try {
      resolveAgentModel(config, "fast-agent", []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toBe(
      'cq.toml: cannot resolve a model for agent "fast-agent": no active token classifies as tier "fast" in [tiers] (candidates: <none>)',
    );
  });

  it("throws CqConfigError when [tiers] is absent (nothing classifies)", () => {
    const config = parseConfig(VALID_TOML);
    expect(() =>
      resolveAgentModel(config, "any-agent", [
        { harness: "claude", model: "opus-4.8", provider: null },
      ]),
    ).toThrow(CqConfigError);
  });
});

describe("T273 — [tiers] error cases: exact CqConfigError messages", () => {
  it("unknown class VALUE throws CqConfigError with exact message", () => {
    let caught: unknown;
    try {
      parseConfig(`
[tiers]
"claude:opus-4.8" = "ultra"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toBe(
      'cq.toml: tiers["claude:opus-4.8"] = "ultra" is not a valid tier class (expected fast, standard, or frontier)',
    );
  });

  it("malformed token KEY (unknown harness) throws CqConfigError with exact message", () => {
    let caught: unknown;
    try {
      parseConfig(`
[tiers]
"gemini:flash" = "fast"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toBe(
      'cq.toml: unknown harness "gemini" in token "gemini:flash" (expected "claude" or "pi")',
    );
  });

  it("malformed token KEY (missing ':') throws CqConfigError", () => {
    let caught: unknown;
    try {
      parseConfig(`
[tiers]
"opus-4.8" = "fast"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toBe(
      'cq.toml: token "opus-4.8" is not "<harness>:<model>" (missing \':\')' ,
    );
  });

  it("malformed token KEY (bare pi) throws CqConfigError with exact message", () => {
    let caught: unknown;
    try {
      parseConfig(`
[tiers]
"pi:minimax-m3" = "fast"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toBe(
      'cq.toml: pi token "pi:minimax-m3" must be "pi:<provider>/<model>" (missing provider qualifier \'/\'; bare pi tokens are no longer accepted)',
    );
  });
});

describe("T282 — parseTiers: fail-loud on a duplicate-token [tiers] classification (D42)", () => {
  it("direct token key + alias key resolving to the SAME token throws CqConfigError naming BOTH keys", () => {
    let caught: unknown;
    try {
      parseConfig(`
[aliases]
opus = "claude:opus-4.8[1m]"

[tiers]
"claude:opus-4.8[1m]" = "frontier"
opus                  = "fast"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    const message = (caught as CqConfigError).message;
    expect(message).toContain('tiers["opus"]');
    expect(message).toContain('tiers["claude:opus-4.8[1m]"]');
    expect(message).toContain("classify the same token");
  });

  // NOTE: two *literal* identical direct keys cannot reach parseTiers — the
  // TOML parser rejects a redefined key first. The reachable "same token under
  // two keys" cases all route through [aliases] (an alias key + a direct key,
  // or two aliases). The class-agnostic guard fires for SAME class too.
  it("alias key + direct key resolving to the SAME token with the SAME class still throws (class-agnostic)", () => {
    let caught: unknown;
    try {
      parseConfig(`
[aliases]
grok = "pi:grok-build/grok-build"

[tiers]
"pi:grok-build/grok-build" = "standard"
grok                       = "standard"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    const message = (caught as CqConfigError).message;
    expect(message).toContain('tiers["grok"]');
    expect(message).toContain('tiers["pi:grok-build/grok-build"]');
    expect(message).toContain("classify the same token");
  });

  it("two distinct aliases resolving to the SAME token throw, naming BOTH alias keys", () => {
    let caught: unknown;
    try {
      parseConfig(`
[aliases]
codex = "pi:grok-build/grok-build"
grok  = "pi:grok-build/grok-build"

[tiers]
codex = "standard"
grok  = "fast"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    const message = (caught as CqConfigError).message;
    expect(message).toContain('tiers["codex"]');
    expect(message).toContain('tiers["grok"]');
    expect(message).toContain("classify the same token");
  });

  it("a single-token-one-class [tiers] does NOT throw", () => {
    expect(() =>
      parseConfig(`
[tiers]
"claude:opus-4.8[1m]" = "frontier"
`),
    ).not.toThrow();
  });

  it("distinct tokens classified under [tiers] do NOT false-positive", () => {
    expect(() =>
      parseConfig(`
[aliases]
minimax = "pi:ollama-cloud/minimax-m3"

[tiers]
"claude:opus-4.8[1m]"      = "frontier"
minimax                    = "fast"
"pi:grok-build/grok-build" = "standard"
`),
    ).not.toThrow();
  });

  // T290 (Q162): effort participates in the dup-guard's token identity.
  it("two [tiers] keys differing ONLY in effort are ACCEPTED (not duplicates)", () => {
    // claude:opus-4.8[1m]:high and :low are distinct tokens — no D42 throw.
    expect(() =>
      parseConfig(`
[tiers]
"claude:opus-4.8[1m]:high" = "frontier"
"claude:opus-4.8[1m]:low"  = "standard"
`),
    ).not.toThrow();
  });

  it("an alias key + a direct key resolving to the SAME effortful token still throws D42", () => {
    let caught: unknown;
    try {
      parseConfig(`
[aliases]
opushi = "claude:opus-4.8[1m]:high"

[tiers]
"claude:opus-4.8[1m]:high" = "frontier"
opushi                     = "standard"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    const message = (caught as CqConfigError).message;
    expect(message).toContain('tiers["opushi"]');
    expect(message).toContain('tiers["claude:opus-4.8[1m]:high"]');
    expect(message).toContain("classify the same token");
  });
});

// T290 (Q162): classifyToken delegates to reviewerTokensEqual, so the same
// model at different efforts classifies to DISTINCT tier classes when both are
// configured. No classifyToken code change is needed — this confirms it.
describe("classifyToken — distinct classes per effort (T290)", () => {
  it("returns distinct classes for the same model at different efforts", () => {
    const config = parseConfig(`
[tiers]
"claude:opus-4.8[1m]:high" = "frontier"
"claude:opus-4.8[1m]:low"  = "standard"
`);
    expect(classifyToken(config, parseReviewerToken("claude:opus-4.8[1m]:high"))).toBe(
      "frontier",
    );
    expect(classifyToken(config, parseReviewerToken("claude:opus-4.8[1m]:low"))).toBe(
      "standard",
    );
  });

  it("does not match an effortless token against an effortful [tiers] entry", () => {
    const config = parseConfig(`
[tiers]
"claude:opus-4.8[1m]:high" = "frontier"
`);
    expect(
      classifyToken(config, parseReviewerToken("claude:opus-4.8[1m]")),
    ).toBeUndefined();
  });
});

describe("T273 — CONFIG-LOAD: parseConfig on no-[tiers] config yields tiers=null with reviewers/planners intact", () => {
  const NO_TIERS_TOML = `
reviewers = ["sonnet", "opus"]
planners  = ["opus"]

[aliases]
sonnet = "claude:sonnet-4.5"
opus   = "claude:opus-4.8[1m]"
`;

  it("parseTiers path: parseConfig yields tiers=null when [tiers] is absent", () => {
    const config = parseConfig(NO_TIERS_TOML);
    expect(config.tiers).toBeNull();
  });

  it("reviewers are intact when [tiers] is absent", () => {
    const config = parseConfig(NO_TIERS_TOML);
    expect(config.reviewers).toEqual(["sonnet", "opus"]);
    expect(resolveReviewers(config)).toEqual([
      { harness: "claude", model: "sonnet-4.5", provider: null, effort: null },
      { harness: "claude", model: "opus-4.8[1m]", provider: null, effort: null },
    ]);
  });

  it("planners are intact when [tiers] is absent", () => {
    const config = parseConfig(NO_TIERS_TOML);
    expect(config.planners).toEqual(["opus"]);
    expect(resolvePlanners(config)).toEqual([
      { harness: "claude", model: "opus-4.8[1m]", provider: null, effort: null },
    ]);
  });

  it("agentTiers is also null when [agent_tiers] is absent", () => {
    const config = parseConfig(NO_TIERS_TOML);
    expect(config.agentTiers).toBeNull();
  });
});

// ── T349: [ledger] backend config key (git-object | fs, default fs) ──────────

describe("parseConfig with [ledger] (T349)", () => {
  it("defaults ledger to null when [ledger] is absent", () => {
    const config = parseConfig(VALID_TOML);
    expect(config.ledger).toBeNull();
  });

  it("[ledger] backend='git-object' resolves to git-object with default branch/remote", () => {
    const config = parseConfig(`
[ledger]
backend = "git-object"
`);
    expect(config.ledger).not.toBeNull();
    expect(config.ledger!.backend).toBe("git-object");
    expect(config.ledger!.branch).toBe("cq-ledger");
    expect(config.ledger!.remote).toBe("origin");
  });

  it("[ledger] backend='fs' resolves to fs with default branch/remote", () => {
    const config = parseConfig(`
[ledger]
backend = "fs"
`);
    expect(config.ledger).not.toBeNull();
    expect(config.ledger!.backend).toBe("fs");
    expect(config.ledger!.branch).toBe("cq-ledger");
    expect(config.ledger!.remote).toBe("origin");
  });

  it("[ledger] backend='git-object' with explicit branch/remote applies overrides", () => {
    const config = parseConfig(`
[ledger]
backend = "git-object"
branch  = "my-branch"
remote  = "upstream"
`);
    expect(config.ledger!.backend).toBe("git-object");
    expect(config.ledger!.branch).toBe("my-branch");
    expect(config.ledger!.remote).toBe("upstream");
  });

  it("omitting [ledger] entirely means backend defaults to fs (null ledger)", () => {
    // Absence of [ledger] => ledger is null; callers treat null as backend='fs'.
    const config = parseConfig(VALID_TOML);
    expect(config.ledger).toBeNull();
  });

  it("throws CqConfigError on an unknown backend value", () => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "rocksdb"
`),
    ).toThrow(CqConfigError);
    expect(() =>
      parseConfig(`
[ledger]
backend = "rocksdb"
`),
    ).toThrow(/backend "rocksdb" is not a valid backend/);
  });

  it("throws CqConfigError on a non-string backend", () => {
    expect(() =>
      parseConfig(`
[ledger]
backend = 42
`),
    ).toThrow(CqConfigError);
    expect(() =>
      parseConfig(`
[ledger]
backend = 42
`),
    ).toThrow(/\[ledger\] backend must be a string/);
  });

  it("throws TomlSyntaxError on an unknown key inside [ledger]", () => {
    expect(() =>
      parseConfig(`
[ledger]
backend = "fs"
bogus = "x"
`),
    ).toThrow(/unexpected key "bogus" in \[ledger\]/);
  });

  it("a commented-out [ledger] block is inert — ledger resolves to null (backend 'fs')", () => {
    // Verifies that TOML comments strip the [ledger] block, leaving ledger=null.
    // CQ_TOML_TEMPLATE carries this commented block; cq-cli/test/cqTomlTemplate.test.ts
    // tests the template end-to-end. This test confirms the parse behaviour in isolation.
    const tomlWithCommentedLedger = `
reviewers = ["opus"]

[aliases]
opus = "claude:opus-4.8[1m]"

# [ledger]
#   backend = "git-object"
#   branch  = "cq-ledger"
#   remote  = "origin"
`;
    const config = parseConfig(tomlWithCommentedLedger);
    expect(config.ledger).toBeNull();
  });
});

describe("resolveAgentModel tie-break: [tiers] order, NOT [aliases] order", () => {
  // Regression guard: [aliases] is an unordered name->token MAP — its ordering
  // must NOT influence which model a tier resolves to. When two aliases share a
  // tier, the winner is the one declared FIRST in [tiers] (the classifier the
  // user writes ordered), regardless of [aliases] order or candidate order.
  //
  // Here [aliases] lists s1 (sonnet-4.6) before s2 (sonnet-5), but [tiers] lists
  // s2 before s1. Candidates are passed in [aliases] order (the "wrong" order).
  // The result must follow [tiers] order -> sonnet-5.
  const SRC = `
reviewers = ["opus"]
planners  = ["opus"]

[aliases]
  opus = "claude:opus-4.8[1m]"
  s1   = "claude:sonnet-4.6"
  s2   = "claude:sonnet-5"

[tiers]
  opus = "frontier"
  s2   = "standard"
  s1   = "standard"

[agent_tiers]
  implement-worker = "standard"
`;

  it("standard-tier agent resolves the FIRST [tiers]-declared token, ignoring [aliases]/candidate order", () => {
    const config = parseConfig(SRC);
    // Candidates in [aliases] order: opus, s1 (sonnet-4.6), s2 (sonnet-5).
    const candidates = Object.values(config.aliases);
    const resolved = resolveAgentModel(config, "implement-worker", candidates);
    expect(resolved).toEqual(parseReviewerToken("claude:sonnet-5"));
  });

  it("reordering [aliases] does not change the result ([aliases] order is inert)", () => {
    // Same [tiers], but [aliases] now lists s2 before s1. Result is identical.
    const reordered = SRC.replace(
      '  s1   = "claude:sonnet-4.6"\n  s2   = "claude:sonnet-5"',
      '  s2   = "claude:sonnet-5"\n  s1   = "claude:sonnet-4.6"',
    );
    const config = parseConfig(reordered);
    const candidates = Object.values(config.aliases);
    const resolved = resolveAgentModel(config, "implement-worker", candidates);
    expect(resolved).toEqual(parseReviewerToken("claude:sonnet-5"));
  });
});
