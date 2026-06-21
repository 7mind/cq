/**
 * T232: provider threading through @cq/config resolvers + configCapability.
 *
 * Asserts that computeReviewers / computeConfig / computePlanners correctly
 * propagate the `provider` field from parsed ReviewerTokens into the
 * GetReviewersResult / GetConfigResult surfaces:
 *   - pi token "pi:ollama-cloud/minimax-m3" → provider: "ollama-cloud"
 *   - claude token "claude:opus-4.8[1m]"   → provider: null
 */

import { describe, it, expect, beforeEach, afterEach, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  computeReviewers,
  computePlanners,
  computeConfig,
  computeAgentModels,
} from "../src/configCapability.js";
import { FsLedgerStore } from "@cq/ledger";

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "t232-"));
  const store = new FsLedgerStore({ root: dir });
  await store.init();
  await store.dispose();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCqToml(contents: string): void {
  writeFileSync(path.join(dir, "cq.toml"), contents, "utf8");
}

const FIXTURE = [
  'reviewers = ["minimax", "claude"]',
  'planners  = ["claude"]',
  "",
  "[aliases]",
  '  minimax = "pi:ollama-cloud/minimax-m3"',
  '  claude  = "claude:opus-4.8[1m]"',
  "",
].join("\n");

describe("T232: provider threading — computeReviewers", () => {
  it("returns provider:'ollama-cloud' for pi token and provider:null for claude token", () => {
    writeCqToml(FIXTURE);
    const result = computeReviewers(dir);
    expect(result.configured).toBe(true);
    expect(result.reviewers).toHaveLength(2);

    const minimax = result.reviewers[0]!;
    expect(minimax.harness).toBe("pi");
    expect(minimax.model).toBe("minimax-m3");
    expect(minimax.provider).toBe("ollama-cloud");
    expect(minimax.alias).toBe("minimax");

    const claude = result.reviewers[1]!;
    expect(claude.harness).toBe("claude");
    expect(claude.model).toBe("opus-4.8[1m]");
    expect(claude.provider).toBeNull();
    expect(claude.alias).toBe("claude");
  });
});

describe("T232: provider threading — computePlanners", () => {
  it("returns provider:null for the claude planner token", () => {
    writeCqToml(FIXTURE);
    const result = computePlanners(dir);
    expect(result.configured).toBe(true);
    expect(result.planners).toHaveLength(1);

    const claude = result.planners[0]!;
    expect(claude.harness).toBe("claude");
    expect(claude.model).toBe("opus-4.8[1m]");
    expect(claude.provider).toBeNull();
    expect(claude.alias).toBe("claude");
  });
});

describe("T232: provider threading — computeConfig aliases", () => {
  it("computeConfig.aliases.minimax.provider === 'ollama-cloud'", () => {
    writeCqToml(FIXTURE);
    const result = computeConfig(dir);
    expect(result.configured).toBe(true);

    const minimax = result.aliases["minimax"];
    expect(minimax).toBeDefined();
    expect(minimax!.provider).toBe("ollama-cloud");
    expect(minimax!.harness).toBe("pi");
    expect(minimax!.model).toBe("minimax-m3");

    const claude = result.aliases["claude"];
    expect(claude).toBeDefined();
    expect(claude!.provider).toBeNull();
  });

  it("computeConfig.aliases.minimax matches full expected shape", () => {
    writeCqToml(FIXTURE);
    const result = computeConfig(dir);
    expect(result.aliases["minimax"]).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
      effort: null,
    });
    expect(result.aliases["claude"]).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
  });
});

describe("T232: provider threading — computeConfig tiers", () => {
  it("threads provider through [tiers] slot", () => {
    writeCqToml(
      [
        'reviewers = ["minimax"]',
        "",
        "[aliases]",
        '  minimax = "pi:ollama-cloud/minimax-m3"',
        '  claude  = "claude:opus-4.8[1m]"',
        "",
        "[tiers]",
        '  minimax = "fast"',
        '  claude  = "standard"',
        "",
      ].join("\n"),
    );
    const result = computeConfig(dir);
    expect(result.tiers).not.toBeNull();
    expect(result.tiers!.fast).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
      effort: null,
    });
    expect(result.tiers!.standard).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
  });
});

// ---- T292: effort threading --------------------------------------------------

const FIXTURE_WITH_EFFORT = [
  'reviewers = ["pi"]',
  'planners  = ["pi"]',
  "",
  "[aliases]",
  '  pi     = "pi:grok-build/grok-build:xhigh"',
  '  claude = "claude:opus-4.8[1m]"',
  "",
].join("\n");

describe("T292: effort threading — computeReviewers", () => {
  it("emits effort:'xhigh' for alias with effort suffix", () => {
    writeCqToml(FIXTURE_WITH_EFFORT);
    const result = computeReviewers(dir);
    expect(result.configured).toBe(true);
    expect(result.reviewers).toHaveLength(1);
    const pi = result.reviewers[0]!;
    expect(pi.harness).toBe("pi");
    expect(pi.model).toBe("grok-build");
    expect(pi.provider).toBe("grok-build");
    expect(pi.alias).toBe("pi");
    expect(pi.effort).toBe("xhigh");
  });

  it("emits effort:null for an effortless alias", () => {
    writeCqToml(
      [
        'reviewers = ["minimax", "claude"]',
        'planners  = ["claude"]',
        "",
        "[aliases]",
        '  minimax = "pi:ollama-cloud/minimax-m3"',
        '  claude  = "claude:opus-4.8[1m]"',
        "",
      ].join("\n"),
    );
    const result = computeReviewers(dir);
    for (const r of result.reviewers) {
      expect(r.effort).toBeNull();
    }
  });
});

describe("T292: effort threading — computePlanners", () => {
  it("emits effort:'xhigh' for planner alias with effort suffix", () => {
    writeCqToml(FIXTURE_WITH_EFFORT);
    const result = computePlanners(dir);
    expect(result.configured).toBe(true);
    expect(result.planners).toHaveLength(1);
    const pi = result.planners[0]!;
    expect(pi.effort).toBe("xhigh");
  });

  it("emits effort:null for an effortless planner", () => {
    writeCqToml(
      [
        'planners = ["claude"]',
        "",
        "[aliases]",
        '  claude = "claude:opus-4.8[1m]"',
        "",
      ].join("\n"),
    );
    const result = computePlanners(dir);
    expect(result.planners[0]!.effort).toBeNull();
  });
});

describe("T292: effort threading — computeConfig aliases", () => {
  it("aliases entry with effort suffix emits effort:'xhigh'", () => {
    writeCqToml(FIXTURE_WITH_EFFORT);
    const result = computeConfig(dir);
    expect(result.aliases["pi"]).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
      effort: "xhigh",
    });
  });

  it("aliases entry without effort suffix emits effort:null", () => {
    writeCqToml(FIXTURE_WITH_EFFORT);
    const result = computeConfig(dir);
    expect(result.aliases["claude"]).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
  });
});

describe("T292: effort threading — computeConfig tiers", () => {
  it("tiers slot with effort token emits effort:'xhigh'", () => {
    writeCqToml(
      [
        'reviewers = ["pi"]',
        "",
        "[aliases]",
        '  pi = "pi:grok-build/grok-build:xhigh"',
        "",
        "[tiers]",
        '  pi = "fast"',
        "",
      ].join("\n"),
    );
    const result = computeConfig(dir);
    expect(result.tiers).not.toBeNull();
    expect(result.tiers!.fast).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
      effort: "xhigh",
    });
  });

  it("tiers slot without effort token emits effort:null", () => {
    writeCqToml(
      [
        'reviewers = ["claude"]',
        "",
        "[aliases]",
        '  claude = "claude:opus-4.8[1m]"',
        "",
        "[tiers]",
        '  claude = "standard"',
        "",
      ].join("\n"),
    );
    const result = computeConfig(dir);
    expect(result.tiers!.standard).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
  });
});

// ---- T437/T438: opus-only panels must not block sonnet for implement-worker -

// Fixture: planners and reviewers both list only "opus" (frontier), but
// [agent_tiers] routes implement-worker to "standard" (sonnet).  The desired
// post-fix behaviour is that implement-worker resolves sonnet DESPITE sonnet
// being absent from every panel — because candidateTokens should draw from
// ALL [aliases], not just planners∪reviewers.
//
// Today (pre-fix) candidateTokens (configCapability.ts ~L159) sources the
// per-role pool only from planners∪reviewers = {opus}, so the standard-tier
// pool is EMPTY and implement-worker resolves status="no-live-token".
//
// T438 flips this to test() once candidateTokens is decoupled to source from
// all [aliases].
// ---- T439/G56: backward-compat — canonical repo cq.toml still resolves -------
//
// The EXACT canonical cq.toml (as of G56/T438 decouple).  codex and grok alias
// the same pi:grok-build/grok-build token which is NOT listed in [tiers], so it
// is unclassified and contributes no resolved slot — that must NOT throw.
// opus (frontier) resolves plan-advance / plan-reviewer / implement-reviewer.
// minimax (standard) resolves implement-worker.

test(
  "T439/G56: canonical cq.toml — implement-worker→minimax, plan-advance→opus, no throw for grok-build",
  async () => {
    writeCqToml(
      [
        'reviewers = ["codex", "grok", "minimax", "opus"]',
        'planners  = ["opus", "grok", "minimax"]',
        "",
        "[aliases]",
        '  codex   = "pi:grok-build/grok-build"',
        '  grok    = "pi:grok-build/grok-build"',
        '  minimax = "pi:ollama-cloud/minimax-m3"',
        '  opus    = "claude:opus-4.8[1m]"',
        "",
        "[agent_tiers]",
        '  investigate-explorer        = "frontier"',
        '  investigate-prober          = "standard"',
        '  plan-advance                = "frontier"',
        '  plan-reviewer               = "frontier"',
        '  implement-worker            = "standard"',
        '  implement-reviewer          = "frontier"',
        '  implement-conflict-resolver = "standard"',
        "",
        "[tiers]",
        '  opus    = "frontier"',
        '  minimax = "standard"',
        "",
      ].join("\n"),
    );

    // Must not throw even though codex/grok are unclassified in [tiers].
    const result = computeAgentModels(dir);

    expect(result.configured).toBe(true);

    // implement-worker: standard tier → minimax (pi:ollama-cloud/minimax-m3)
    const implWorker = result.agents.find((a) => a.id === "implement-worker");
    expect(implWorker).toBeDefined();
    expect(implWorker!.status).toBe("resolved");
    expect(implWorker!.modelClass).toBe("standard");
    expect(implWorker!.modelMappings.pi).toEqual(["ollama-cloud/minimax-m3"]);
    expect(implWorker!.modelMappings.claude).toBeUndefined();

    // plan-advance: frontier tier → opus (claude:opus-4.8[1m])
    const planAdvance = result.agents.find((a) => a.id === "plan-advance");
    expect(planAdvance).toBeDefined();
    expect(planAdvance!.status).toBe("resolved");
    expect(planAdvance!.modelClass).toBe("frontier");
    expect(planAdvance!.modelMappings.claude).toEqual(["opus-4.8[1m]"]);
    expect(planAdvance!.modelMappings.pi).toBeUndefined();

    // plan-reviewer: frontier tier → opus
    const planReviewer = result.agents.find((a) => a.id === "plan-reviewer");
    expect(planReviewer).toBeDefined();
    expect(planReviewer!.status).toBe("resolved");
    expect(planReviewer!.modelClass).toBe("frontier");
    expect(planReviewer!.modelMappings.claude).toEqual(["opus-4.8[1m]"]);

    // implement-reviewer: frontier tier → opus
    const implReviewer = result.agents.find(
      (a) => a.id === "implement-reviewer",
    );
    expect(implReviewer).toBeDefined();
    expect(implReviewer!.status).toBe("resolved");
    expect(implReviewer!.modelClass).toBe("frontier");
    expect(implReviewer!.modelMappings.claude).toEqual(["opus-4.8[1m]"]);
  },
);

test(
  "T437: implement-worker resolves sonnet even when sonnet is off every panel",
  async () => {
    writeCqToml(
      [
        'reviewers = ["opus"]',
        'planners  = ["opus"]',
        "",
        "[aliases]",
        '  opus   = "claude:opus-4.8[1m]"',
        '  sonnet = "claude:sonnet-4.6"',
        "",
        "[tiers]",
        '  opus   = "frontier"',
        '  sonnet = "standard"',
        "",
        "[agent_tiers]",
        '  implement-worker = "standard"',
        '  plan-advance     = "frontier"',
        "",
      ].join("\n"),
    );

    const result = computeAgentModels(dir);

    expect(result.configured).toBe(true);

    const implWorker = result.agents.find((a) => a.id === "implement-worker");
    expect(implWorker).toBeDefined();
    expect(implWorker!.status).toBe("resolved");
    expect(implWorker!.modelClass).toBe("standard");
    expect(implWorker!.modelMappings.claude).toEqual(["sonnet-4.6"]);

    const planAdvance = result.agents.find((a) => a.id === "plan-advance");
    expect(planAdvance).toBeDefined();
    expect(planAdvance!.modelClass).toBe("frontier");
    expect(planAdvance!.modelMappings.claude).toEqual(["opus-4.8[1m]"]);
  },
);

// ---- T481: configCapability resolves the ACTIVE harness (CQ_HARNESS) ---------
//
// loadConfig's harness param defaults to resolveActiveHarnessFromProcess(), so
// each compute* method (which re-reads cq.toml per call) resolves the ACTIVE
// harness from process.env at that boundary. With a fixture carrying a
// [harness.pi] override (grok panels) + [harness.pi.tiers] (grok=frontier) and
// shared [aliases] (incl grok/opus), the merged view must be harness-scoped:
//   - under CQ_HARNESS=pi: planners → grok; plan-advance (frontier) → pi token.
//   - under CQ_HARNESS=claude: planners → opus (shared default panel).
// [aliases] is SHARED, so candidateTokens is unchanged; only [tiers]
// classification + panels become harness-scoped via the merged config.

const T481_HARNESS_FIXTURE = [
  // SHARED defaults: claude panels + claude-classified frontier tier.
  'reviewers = ["opus"]',
  'planners  = ["opus"]',
  "",
  "[aliases]",
  '  opus = "claude:opus-4.8[1m]"',
  '  grok = "pi:grok-build/grok-build"',
  "",
  "[tiers]",
  '  opus = "frontier"',
  "",
  "[agent_tiers]",
  '  plan-advance = "frontier"',
  "",
  // PER-HARNESS pi override: grok panels + grok-classified frontier tier.
  "[harness.pi]",
  '  reviewers = ["grok"]',
  '  planners  = ["grok"]',
  "",
  "[harness.pi.tiers]",
  '  grok = "frontier"',
  "",
].join("\n");

describe("T481: configCapability resolves the ACTIVE harness", () => {
  const savedHarness = process.env["CQ_HARNESS"];

  afterEach(() => {
    if (savedHarness === undefined) {
      delete process.env["CQ_HARNESS"];
    } else {
      process.env["CQ_HARNESS"] = savedHarness;
    }
  });

  it("computePlanners() under CQ_HARNESS=pi returns the grok planner", () => {
    writeCqToml(T481_HARNESS_FIXTURE);
    process.env["CQ_HARNESS"] = "pi";
    const result = computePlanners(dir);
    expect(result.configured).toBe(true);
    expect(result.planners).toHaveLength(1);
    const grok = result.planners[0]!;
    expect(grok.harness).toBe("pi");
    expect(grok.model).toBe("grok-build");
    expect(grok.provider).toBe("grok-build");
    expect(grok.alias).toBe("grok");
  });

  it("computePlanners() under CQ_HARNESS=claude returns the opus planner", () => {
    writeCqToml(T481_HARNESS_FIXTURE);
    process.env["CQ_HARNESS"] = "claude";
    const result = computePlanners(dir);
    expect(result.configured).toBe(true);
    expect(result.planners).toHaveLength(1);
    const opus = result.planners[0]!;
    expect(opus.harness).toBe("claude");
    expect(opus.model).toBe("opus-4.8[1m]");
    expect(opus.provider).toBeNull();
    expect(opus.alias).toBe("opus");
  });

  it("computeAgentModels() under CQ_HARNESS=pi resolves plan-advance (frontier) to a pi token", () => {
    writeCqToml(T481_HARNESS_FIXTURE);
    process.env["CQ_HARNESS"] = "pi";
    const result = computeAgentModels(dir);
    expect(result.configured).toBe(true);
    const planAdvance = result.agents.find((a) => a.id === "plan-advance");
    expect(planAdvance).toBeDefined();
    expect(planAdvance!.status).toBe("resolved");
    expect(planAdvance!.modelClass).toBe("frontier");
    // Under pi, [harness.pi.tiers] classifies grok=frontier, so plan-advance
    // resolves the pi grok token (and NOT the shared opus claude token).
    expect(planAdvance!.modelMappings.pi).toEqual(["grok-build/grok-build"]);
    expect(planAdvance!.modelMappings.claude).toBeUndefined();
  });

  it("computeAgentModels() under CQ_HARNESS=claude resolves plan-advance (frontier) to the opus claude token", () => {
    writeCqToml(T481_HARNESS_FIXTURE);
    process.env["CQ_HARNESS"] = "claude";
    const result = computeAgentModels(dir);
    const planAdvance = result.agents.find((a) => a.id === "plan-advance");
    expect(planAdvance).toBeDefined();
    expect(planAdvance!.status).toBe("resolved");
    expect(planAdvance!.modelClass).toBe("frontier");
    expect(planAdvance!.modelMappings.claude).toEqual(["opus-4.8[1m]"]);
    expect(planAdvance!.modelMappings.pi).toBeUndefined();
  });
});
