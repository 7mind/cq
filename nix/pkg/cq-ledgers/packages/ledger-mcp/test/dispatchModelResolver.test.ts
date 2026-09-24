/** G224 / K332: which token a CQ-driven dispatch runs at, from trusted configuration only. */

import { describe, expect, test } from "bun:test";
import { parseConfig } from "@cq/config";
import { createConfiguredDispatchModelResolver } from "../src/dispatchModelResolver.js";

const TOML = [
  "[aliases]",
  '  opus  = "claude:opus"',
  '  sonnet = "claude:sonnet"',
  '  grok  = "pi:xai/grok-4.6:high"',
  '  terra = "pi:openai-codex/gpt-5.6-terra:high"',
  "",
  "[agent_tiers]",
  '  plan-advance     = "frontier"',
  '  implement-worker = "standard"',
  "",
  "[agent_efforts]",
  '  plan-advance = "max"',
  "",
  "[harness.claude]",
  '  reviewers = ["opus", "grok"]',
  '  planners  = ["opus"]',
  "[harness.claude.tiers]",
  '  frontier = "opus"',
  '  standard = "terra"',
  "",
].join("\n");

const resolver = createConfiguredDispatchModelResolver(() => parseConfig(TOML, "claude"));

describe("createConfiguredDispatchModelResolver", () => {
  test("defaults to the role's tier token with its effort override", () => {
    expect(resolver("plan-advance", undefined)).toEqual({
      token: { harness: "claude", model: "opus", provider: null, effort: "max" },
      formatted: "claude:opus:max",
    });
  });

  test("a tier token naming another harness makes the dispatch cross-harness", () => {
    expect(resolver("implement-worker", undefined).token).toMatchObject({
      harness: "pi",
      provider: "openai-codex",
      model: "gpt-5.6-terra",
    });
  });

  test("an explicit panel member is dispatchable", () => {
    expect(resolver("implement-reviewer", "pi:xai/grok-4.6:high").formatted).toBe("pi:xai/grok-4.6:high");
  });

  test("an explicit tier token is dispatchable", () => {
    expect(resolver("implement-worker", "pi:openai-codex/gpt-5.6-terra:high").token.harness).toBe("pi");
  });

  test("a well-formed token the configuration does not name is refused", () => {
    expect(() => resolver("implement-reviewer", "claude:haiku")).toThrow(/not dispatchable/);
  });

  test("a malformed token is refused", () => {
    expect(() => resolver("implement-reviewer", "not a token")).toThrow();
  });

  test("a project without configuration cannot resolve any model", () => {
    const unconfigured = createConfiguredDispatchModelResolver(() => null);
    expect(() => unconfigured("plan-advance", undefined)).toThrow(/cq\.toml/);
  });
});
