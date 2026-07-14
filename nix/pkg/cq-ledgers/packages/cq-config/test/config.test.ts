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
  tierModel,
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

  it("accepts GPT-5.6 pi efforts max and none (pi:p/m:max, pi:p/m:none)", () => {
    // GPT-5.6 brought `max` and `none` into the pi vocabulary.
    expect(parseReviewerToken("pi:p/m:max")).toEqual({
      harness: "pi",
      model: "m",
      provider: "p",
      effort: "max",
    });
    expect(parseReviewerToken("pi:p/m:none")).toEqual({
      harness: "pi",
      model: "m",
      provider: "p",
      effort: "none",
    });
  });

  it("rejects a bogus pi effort (pi:p/m:bogus)", () => {
    expect(() => parseReviewerToken("pi:p/m:bogus")).toThrow(CqConfigError);
    expect(() => parseReviewerToken("pi:p/m:bogus")).toThrow(/bogus/);
    expect(() => parseReviewerToken("pi:p/m:bogus")).toThrow(/xhigh/);
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
fast = "pi:ollama-cloud/minimax-m3"
standard = "grok"
frontier = "opus"

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

  it("throws on a non-tier KEY in [tiers]", () => {
    // KEY is a tier class; VALUE is a model. A KEY that is not a tier class
    // (here a token string) is rejected naming the tier set.
    expect(() =>
      parseConfig(`
[tiers]
"claude:opus-4.8[1m]" = "fast"
`),
    ).toThrow(/is not a valid tier/i);
  });

  it("throws on a token VALUE with an unknown harness", () => {
    // VALUE is a bare token; an unknown harness in it surfaces
    // parseReviewerToken's precise error.
    expect(() =>
      parseConfig(`
[tiers]
fast = "gemini:flash"
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

describe("resolveAgentModel end-to-end (T223 acceptance c)", () => {
  it("resolves agent-name -> tier -> the tier's model", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    // investigate-explorer -> frontier -> opus (the frontier model)
    expect(resolveAgentModel(config, "investigate-explorer")).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
    // implement-worker -> standard -> grok (alias -> pi:grok-build/grok-build)
    expect(resolveAgentModel(config, "implement-worker")).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
      effort: null,
    });
  });

  it("resolves an unlisted agent to the DEFAULT_TIER (standard) model", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    // unlisted agent -> standard (DEFAULT_TIER); grok is the standard model.
    expect(resolveAgentModel(config, "unlisted-agent")).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
      effort: null,
    });
  });

  it("throws when [tiers] is absent (no model for the tier)", () => {
    const config = parseConfig(VALID_TOML);
    expect(() => resolveAgentModel(config, "any-agent")).toThrow(CqConfigError);
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
frontier = "claude:haiku-4.5"
standard = "pi:grok-build/grok-build"
fast     = "claude:sonnet-4.5"
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

  it("parses fast = \"claude:haiku-4.5\" in isolation", () => {
    const config = parseConfig(`
[tiers]
fast = "claude:haiku-4.5"
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

  it("parses an alias VALUE (resolves through [aliases])", () => {
    const config = parseConfig(`
[aliases]
opus = "claude:opus-4.8[1m]"

[tiers]
frontier = "opus"
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

describe("T273 — tierModel: the model configured for each tier", () => {
  it("tierModel returns claude:haiku-4.5 for frontier (direct claude value)", () => {
    const config = parseConfig(TIERS_TOML);
    expect(tierModel(config, "frontier")).toEqual({
      harness: "claude",
      model: "haiku-4.5",
      provider: null,
      effort: null,
    });
  });

  it("tierModel returns pi:grok-build/grok-build for standard (direct pi value)", () => {
    const config = parseConfig(TIERS_TOML);
    expect(tierModel(config, "standard")).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
      effort: null,
    });
  });

  it("tierModel returns claude:sonnet-4.5 for fast (direct claude value)", () => {
    const config = parseConfig(TIERS_TOML);
    expect(tierModel(config, "fast")).toEqual({
      harness: "claude",
      model: "sonnet-4.5",
      provider: null,
      effort: null,
    });
  });

  it("tierModel returns undefined when [tiers] is absent", () => {
    const config = parseConfig(VALID_TOML);
    expect(tierModel(config, "frontier")).toBeUndefined();
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
fast     = "claude:haiku-4.5"
standard = "claude:sonnet-4.5"
frontier = "pi:ollama-cloud/minimax-m3"

[agent_tiers]
fast-agent     = "fast"
standard-agent = "standard"
frontier-agent = "frontier"
`;

  it("resolves fast-agent -> fast -> claude:haiku-4.5", () => {
    const config = parseConfig(CLEAN_TOML);
    expect(resolveAgentModel(config, "fast-agent")).toEqual({
      harness: "claude",
      model: "haiku-4.5",
      provider: null,
      effort: null,
    });
  });

  it("resolves standard-agent -> standard -> claude:sonnet-4.5", () => {
    const config = parseConfig(CLEAN_TOML);
    expect(resolveAgentModel(config, "standard-agent")).toEqual({
      harness: "claude",
      model: "sonnet-4.5",
      provider: null,
      effort: null,
    });
  });

  it("resolves frontier-agent -> frontier -> pi:ollama-cloud/minimax-m3", () => {
    const config = parseConfig(CLEAN_TOML);
    expect(resolveAgentModel(config, "frontier-agent")).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
      effort: null,
    });
  });

  it("unlisted agent falls back to DEFAULT_TIER ('standard') and resolves", () => {
    const config = parseConfig(CLEAN_TOML);
    expect(resolveAgentModel(config, "unknown-agent")).toEqual({
      harness: "claude",
      model: "sonnet-4.5",
      provider: null,
      effort: null,
    });
  });

  it("throws CqConfigError with the exact message when the agent's tier has no model", () => {
    // [tiers] configures only standard; fast-agent's tier (fast) has no model.
    const config = parseConfig(`
[tiers]
standard = "claude:sonnet-4.5"

[agent_tiers]
fast-agent = "fast"
`);
    let caught: unknown;
    try {
      resolveAgentModel(config, "fast-agent");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toBe(
      'cq.toml: cannot resolve a model for agent "fast-agent": [tiers] configures no model for tier "fast"',
    );
  });

  it("throws CqConfigError when [tiers] is absent (no model for the tier)", () => {
    const config = parseConfig(VALID_TOML);
    expect(() => resolveAgentModel(config, "any-agent")).toThrow(CqConfigError);
  });
});

describe("T273 — [tiers] error cases: exact CqConfigError messages", () => {
  it("non-tier KEY throws CqConfigError with exact message", () => {
    let caught: unknown;
    try {
      parseConfig(`
[tiers]
"claude:opus-4.8" = "fast"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toBe(
      'cq.toml: tiers key "claude:opus-4.8" is not a valid tier (expected fast, standard, or frontier)',
    );
  });

  it("malformed token VALUE (unknown harness) throws CqConfigError with exact message", () => {
    let caught: unknown;
    try {
      parseConfig(`
[tiers]
fast = "gemini:flash"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toBe(
      'cq.toml: unknown harness "gemini" in token "gemini:flash" (expected "claude" or "pi")',
    );
  });

  it("malformed token VALUE (missing ':') throws CqConfigError", () => {
    let caught: unknown;
    try {
      parseConfig(`
[tiers]
fast = "opus-4.8"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toBe(
      'cq.toml: token "opus-4.8" is not "<harness>:<model>" (missing \':\')' ,
    );
  });

  it("malformed token VALUE (bare pi) throws CqConfigError with exact message", () => {
    let caught: unknown;
    try {
      parseConfig(`
[tiers]
fast = "pi:minimax-m3"
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

describe("parseTiers — a model may serve several tiers (tier -> model map)", () => {
  it("accepts the SAME model under multiple tiers", () => {
    // tier -> model: TOML keys are unique per tier, but nothing forbids one
    // model from appearing as the VALUE of several tiers.
    const config = parseConfig(`
[aliases]
opus = "claude:opus-4.8[1m]"

[tiers]
frontier = "opus"
standard = "opus"
`);
    expect(tierModel(config, "frontier")).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
    expect(tierModel(config, "standard")).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
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

// ── T494: [ledger] "xdg" backend, `backup` mode, `projectId` (K102/Q244/Q246) ──

describe("parseConfig with [ledger] backend='xdg', backup, projectId (T494)", () => {
  it("[ledger] backend='xdg' parses (the new out-of-tree bun:sqlite primary, K102)", () => {
    const config = parseConfig(`
[ledger]
backend = "xdg"
`);
    expect(config.ledger).not.toBeNull();
    expect(config.ledger!.backend).toBe("xdg");
  });

  it("backup defaults to 'none' when [ledger] is present but backup is absent (Q244 — OFF by default)", () => {
    const config = parseConfig(`
[ledger]
backend = "fs"
`);
    expect(config.ledger!.backup).toBe("none");
  });

  it("backup defaults to 'none' when [ledger] is absent entirely", () => {
    // [ledger] itself is null when absent, but this documents that the DEFAULT
    // a caller should assume for backup (mirroring the backend='fs' default)
    // is 'none', consistent with the Q244 OFF-by-default requirement.
    const config = parseConfig(VALID_TOML);
    expect(config.ledger).toBeNull();
  });

  it("backup='in-tree' parses", () => {
    const config = parseConfig(`
[ledger]
backup = "in-tree"
`);
    expect(config.ledger!.backup).toBe("in-tree");
  });

  it("backup='orphan-branch' parses", () => {
    const config = parseConfig(`
[ledger]
backup = "orphan-branch"
`);
    expect(config.ledger!.backup).toBe("orphan-branch");
  });

  it("throws CqConfigError on an unknown backup value", () => {
    expect(() =>
      parseConfig(`
[ledger]
backup = "s3"
`),
    ).toThrow(CqConfigError);
    expect(() =>
      parseConfig(`
[ledger]
backup = "s3"
`),
    ).toThrow(/backup "s3" is not a valid backup mode/);
  });

  it("throws CqConfigError on a non-string backup", () => {
    expect(() =>
      parseConfig(`
[ledger]
backup = 42
`),
    ).toThrow(/\[ledger\] backup must be a string/);
  });

  it("projectId is optional — null when absent", () => {
    const config = parseConfig(`
[ledger]
backend = "xdg"
`);
    expect(config.ledger!.projectId).toBeNull();
  });

  it("projectId parses as a string when present", () => {
    const config = parseConfig(`
[ledger]
projectId = "my-repo-identity"
`);
    expect(config.ledger!.projectId).toBe("my-repo-identity");
  });

  it("throws CqConfigError on a non-string projectId", () => {
    expect(() =>
      parseConfig(`
[ledger]
projectId = 42
`),
    ).toThrow(/\[ledger\] projectId must be a string/);
  });

  it("legacy backend 'fs' still parses (PARSEABLE for cq migrate)", () => {
    const config = parseConfig(`
[ledger]
backend = "fs"
`);
    expect(config.ledger!.backend).toBe("fs");
  });

  it("legacy backend 'git-object' still parses (PARSEABLE for cq migrate)", () => {
    const config = parseConfig(`
[ledger]
backend = "git-object"
`);
    expect(config.ledger!.backend).toBe("git-object");
  });

  it("all new keys together: backend='xdg', backup='in-tree', projectId set", () => {
    const config = parseConfig(`
[ledger]
backend   = "xdg"
backup    = "in-tree"
projectId = "acme-widgets"
`);
    expect(config.ledger).toEqual({
      backend: "xdg",
      branch: "cq-ledger",
      remote: "origin",
      backup: "in-tree",
      projectId: "acme-widgets",
    });
  });
});
