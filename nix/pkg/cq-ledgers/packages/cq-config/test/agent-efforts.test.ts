/**
 * T518 (Q254): `[agent_efforts]` — per-agent reasoning-effort override,
 * ORTHOGONAL to `[agent_tiers]`.
 *
 * Asserts:
 *  (a) `[agent_efforts]` parses into `config.agentEfforts`; absent table
 *      defaults to `{}`;
 *  (b) resolveAgentModel applies the override ON TOP of the resolved tier
 *      token's effort — override wins (even over an explicit `:<effort>`
 *      suffix), absent entry is a no-op;
 *  (c) an effort value outside the overall vocabulary fails PARSE with a
 *      precise CqConfigError; a value legal only for the OTHER harness fails
 *      at RESOLUTION time (per the resolved token's harness, via isEffort);
 *  (d) the tier axis is untouched — model/provider/tier resolution is
 *      byte-identical with and without `[agent_efforts]`.
 */

import { describe, it, expect } from "bun:test";
import {
  parseConfig,
  resolveAgentModel,
  resolveAgentTier,
  applyAgentEffort,
  tierModel,
  parseReviewerToken,
  CqConfigError,
} from "../src/index.js";

const BASE = [
  "[aliases]",
  '  opus  = "claude:opus-4.8[1m]:xhigh"',
  '  haiku = "claude:haiku"',
  '  grok  = "pi:grok-build/grok-build:high"',
  "",
  "[tiers]",
  '  frontier = "opus"',
  '  standard = "grok"',
  '  fast     = "haiku"',
  "",
  "[agent_tiers]",
  '  plan-reviewer    = "frontier"',
  '  implement-worker = "standard"',
].join("\n");

describe("[agent_efforts] parsing (Q254)", () => {
  it("parses agent-name -> effort into config.agentEfforts", () => {
    const config = parseConfig(
      `${BASE}\n[agent_efforts]\n  plan-reviewer = "max"\n`,
    );
    expect(config.agentEfforts).toEqual({ "plan-reviewer": "max" });
  });

  it("defaults agentEfforts to {} when [agent_efforts] is absent", () => {
    const config = parseConfig(BASE);
    expect(config.agentEfforts).toEqual({});
  });

  it("fails parse on an effort value outside the overall vocabulary", () => {
    expect(() =>
      parseConfig(`${BASE}\n[agent_efforts]\n  plan-reviewer = "turbo"\n`),
    ).toThrow(CqConfigError);
    expect(() =>
      parseConfig(`${BASE}\n[agent_efforts]\n  plan-reviewer = "turbo"\n`),
    ).toThrow(/agent_efforts\["plan-reviewer"\] = "turbo" is not a valid effort/);
  });

  it("rejects [agent_efforts] inside a [harness.<name>] block (shared-only)", () => {
    expect(() =>
      parseConfig(
        `${BASE}\n[harness.claude.agent_efforts]\n  plan-reviewer = "max"\n`,
      ),
    ).toThrow(/unexpected key "agent_efforts" in \[harness\.claude\]/);
  });
});

describe("[agent_efforts] resolution — override wins, absent no-op (Q254)", () => {
  it("overrides an explicit tier-token effort (:xhigh -> :max)", () => {
    const config = parseConfig(
      `${BASE}\n[agent_efforts]\n  plan-reviewer = "max"\n`,
    );
    const token = resolveAgentModel(config, "plan-reviewer");
    expect(token.harness).toBe("claude");
    expect(token.model).toBe("opus-4.8[1m]");
    expect(token.effort).toBe("max");
  });

  it("sets the effort on a tier token that has NO effort suffix", () => {
    // Route implement-worker to the fast tier: haiku carries no ":<effort>".
    const config = parseConfig(
      `${BASE.replace('implement-worker = "standard"', 'implement-worker = "fast"')}\n[agent_efforts]\n  implement-worker = "low"\n`,
    );
    const token = resolveAgentModel(config, "implement-worker");
    expect(token.model).toBe("haiku");
    expect(token.effort).toBe("low");
  });

  it("applies to a DEFAULT_TIER agent (no [agent_tiers] entry)", () => {
    // investigate-prober has no [agent_tiers] entry -> standard -> grok (pi).
    const config = parseConfig(
      `${BASE}\n[agent_efforts]\n  investigate-prober = "low"\n`,
    );
    const prober = resolveAgentModel(config, "investigate-prober");
    expect(prober.harness).toBe("pi");
    expect(prober.effort).toBe("low");
  });

  it("absent [agent_efforts] entry leaves the tier token effort unchanged", () => {
    const config = parseConfig(
      `${BASE}\n[agent_efforts]\n  plan-reviewer = "max"\n`,
    );
    const worker = resolveAgentModel(config, "implement-worker");
    expect(worker.effort).toBe("high");
    const noTable = resolveAgentModel(parseConfig(BASE), "plan-reviewer");
    expect(noTable.effort).toBe("xhigh");
  });

  it("keeps the axes orthogonal — tier/model/provider resolution unchanged", () => {
    const plain = parseConfig(BASE);
    const overridden = parseConfig(
      `${BASE}\n[agent_efforts]\n  plan-reviewer = "max"\n  implement-worker = "medium"\n`,
    );
    for (const agent of ["plan-reviewer", "implement-worker"]) {
      expect(resolveAgentTier(overridden, agent)).toBe(
        resolveAgentTier(plain, agent),
      );
      const a = resolveAgentModel(plain, agent);
      const b = resolveAgentModel(overridden, agent);
      expect(b.harness).toBe(a.harness);
      expect(b.model).toBe(a.model);
      expect(b.provider).toBe(a.provider);
    }
  });

  it("fails fast on an effort invalid for the RESOLVED harness (claude + 'off')", () => {
    // "off" is a legal pi effort, so it parses; plan-reviewer resolves to a
    // claude token, where "off" is illegal -> CqConfigError at resolve time.
    const config = parseConfig(
      `${BASE}\n[agent_efforts]\n  plan-reviewer = "off"\n`,
    );
    expect(() => resolveAgentModel(config, "plan-reviewer")).toThrow(
      CqConfigError,
    );
    expect(() => resolveAgentModel(config, "plan-reviewer")).toThrow(
      /agent_efforts\["plan-reviewer"\] = "off" is not a valid effort for harness "claude"/,
    );
  });

  it("accepts a pi-only effort for a pi-resolved agent ('off')", () => {
    const config = parseConfig(
      `${BASE}\n[agent_efforts]\n  implement-worker = "off"\n`,
    );
    const token = resolveAgentModel(config, "implement-worker");
    expect(token.harness).toBe("pi");
    expect(token.effort).toBe("off");
  });
});

describe("applyAgentEffort — the resolution hook itself (Q254)", () => {
  it("returns the token unchanged when the agent has no override", () => {
    const config = parseConfig(BASE);
    const token = parseReviewerToken("claude:opus-4.8[1m]:xhigh");
    expect(applyAgentEffort(config, "plan-reviewer", token)).toBe(token);
  });

  it("returns a copy with the overridden effort when an override exists", () => {
    const config = parseConfig(
      `${BASE}\n[agent_efforts]\n  plan-reviewer = "max"\n`,
    );
    const token = tierModel(config, "frontier")!;
    const applied = applyAgentEffort(config, "plan-reviewer", token);
    expect(applied.effort).toBe("max");
    // The input token is not mutated (tier resolution stays pure).
    expect(token.effort).toBe("xhigh");
  });
});
