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
    });
  });

  it("parses a claude token with provider null", () => {
    const tok: ReviewerToken = parseReviewerToken("claude:opus-4.8[1m]");
    expect(tok).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
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

  it("preserves colons inside the model segment (pi:prov/a:b)", () => {
    const tok: ReviewerToken = parseReviewerToken("pi:prov/a:b");
    expect(tok).toEqual({
      harness: "pi",
      model: "a:b",
      provider: "prov",
    });
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
      codex: { harness: "pi", model: "grok-build", provider: "grok-build" },
      grok: { harness: "pi", model: "grok-build", provider: "grok-build" },
      opus: { harness: "claude", model: "opus-4.8", provider: null },
    });
    // CqConfig.reviewers holds the raw ALIAS names (not yet resolved).
    expect(cfg.reviewers).toEqual(["codex", "grok", "opus"]);
    // Resolution through [aliases] yields the ReviewerToken[].
    expect(resolveReviewers(cfg)).toEqual([
      { harness: "pi", model: "grok-build", provider: "grok-build" },
      { harness: "pi", model: "grok-build", provider: "grok-build" },
      { harness: "claude", model: "opus-4.8", provider: null },
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
      { harness: "pi", model: "grok-build", provider: "grok-build" },
      { harness: "pi", model: "grok-build", provider: "grok-build" },
      { harness: "claude", model: "opus-4.8", provider: null },
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
      { harness: "claude", model: "opus-4.8", provider: null },
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
      { harness: "claude", model: "opus-4.8", provider: null },
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
minimax = "standard"
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
    });
  });

  it("resolves a tier value that names an alias", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    // 'standard' = "minimax" — a name in [aliases] -> pi:ollama-cloud/minimax-m3
    const standardEntry = config.tiers!.entries.find(
      (e) => e.class === "standard",
    );
    expect(standardEntry?.token).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
    });
    // 'frontier' = "opus" — a name in [aliases] -> claude:opus-4.8[1m]
    const frontierEntry = config.tiers!.entries.find(
      (e) => e.class === "frontier",
    );
    expect(frontierEntry?.token).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
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
    { harness: "pi", model: "grok-build", provider: "grok-build" }, // unclassified
  ];

  it("resolves agent-name -> tier -> first classified candidate", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    // investigate-explorer -> frontier -> only opus classifies as frontier
    expect(resolveAgentModel(config, "investigate-explorer", ALL_TOKENS)).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
    });
    // implement-worker -> standard. In VALID_TOML_WITH_TIERS, `minimax` (the
    // alias KEY) classifies as standard; its token is pi:ollama-cloud/minimax-m3,
    // which is also the fast-classified direct token — document-order in [tiers]
    // means the direct `pi:...` key (fast) wins for that exact token. So no
    // candidate classifies as standard here and resolveAgentModel throws.
    expect(() =>
      resolveAgentModel(config, "implement-worker", ALL_TOKENS),
    ).toThrow(CqConfigError);
  });

  it("throws for an unlisted agent when no candidate classifies to DEFAULT_TIER", () => {
    const config = parseConfig(VALID_TOML_WITH_TIERS);
    // unlisted agent -> standard (DEFAULT_TIER); no candidate classifies as
    // standard (see note above), so resolveAgentModel throws.
    expect(() =>
      resolveAgentModel(config, "unlisted-agent", ALL_TOKENS),
    ).toThrow(CqConfigError);
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
      codex: { harness: "pi", model: "grok-build", provider: "grok-build" },
      grok: { harness: "pi", model: "grok-build", provider: "grok-build" },
      opus: { harness: "claude", model: "opus-4.8", provider: null },
    });
    expect(config.reviewers).toEqual(["codex", "grok", "opus"]);
    expect(config.planners).toEqual([]);
    // new fields are null (not present)
    expect(config.tiers).toBeNull();
    expect(config.agentTiers).toBeNull();
    // resolveReviewers still works
    expect(resolveReviewers(config)).toEqual([
      { harness: "pi", model: "grok-build", provider: "grok-build" },
      { harness: "pi", model: "grok-build", provider: "grok-build" },
      { harness: "claude", model: "opus-4.8", provider: null },
    ]);
  });

  it("whitelist still rejects unknown top-level keys", () => {
    expect(() => parseConfig(`[bogus]\nx = 1\n`)).toThrow(
      /unexpected top-level key bogus/,
    );
  });
});
