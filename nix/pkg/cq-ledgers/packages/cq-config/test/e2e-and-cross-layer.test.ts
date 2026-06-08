/**
 * T238: @cq/config end-to-end + cross-layer consistency tests.
 *
 * (1) End-to-end resolve test: a cq.toml with minimax alias, reviewers/planners
 *     referencing minimax, and [tiers]/[agent_tiers] — resolveReviewers/
 *     resolvePlanners return tokens with provider:'ollama-cloud', model:'minimax-m3'.
 *
 * (2) Bare-pi rejection test: a cq.toml with a bare pi:<model> (no provider
 *     qualifier) throws CqConfigError at parse/load time.
 *
 * (3) Cross-layer consistency test (K50 regression guard): a LOCAL REPLICA of
 *     the extension's tokenToChildModel logic (from
 *     nix/pkg/pi-extensions/cq-subagent-dispatch.ts, the T233 version) is
 *     asserted to agree with parseReviewerToken on the pi fixture cases.
 *     The replica faithfully copies tokenToChildModel (harness !== 'pi' → null;
 *     no slash → null; empty half → null; else {provider, model}).
 *     Over pi tokens: parseReviewerToken ACCEPTS iff replica ACCEPTS, and when
 *     both accept they agree on provider+model.
 *     Over claude tokens: each layer's independent expected behavior is asserted.
 */

import { describe, it, expect } from "bun:test";
import {
  parseConfig,
  parseReviewerToken,
  resolveReviewers,
  resolvePlanners,
  resolveAgentModel,
  CqConfigError,
} from "../src/index.js";

// ── (1) End-to-end resolve test ──────────────────────────────────────────────

const E2E_TOML = `
reviewers = ["minimax", "opus"]
planners = ["minimax"]

[aliases]
minimax = "pi:ollama-cloud/minimax-m3"
opus    = "claude:opus-4.8[1m]"

[tiers]
minimax = "standard"
opus     = "frontier"

[agent_tiers]
implement-worker     = "standard"
implement-reviewer   = "standard"
investigate-explorer = "frontier"
`;

describe("end-to-end resolve — minimax alias through reviewers/planners (T238)", () => {
  it("resolveReviewers returns provider:'ollama-cloud', model:'minimax-m3' for minimax", () => {
    const config = parseConfig(E2E_TOML);
    const resolved = resolveReviewers(config);
    expect(resolved[0]).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
    });
    // second reviewer (opus) is claude
    expect(resolved[1]).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
    });
  });

  it("resolvePlanners returns provider:'ollama-cloud', model:'minimax-m3' for minimax", () => {
    const config = parseConfig(E2E_TOML);
    const resolved = resolvePlanners(config);
    expect(resolved).toEqual([
      {
        harness: "pi",
        model: "minimax-m3",
        provider: "ollama-cloud",
      },
    ]);
  });

  it("resolveAgentModel resolves implement-worker -> standard -> minimax -> provider+model", () => {
    const config = parseConfig(E2E_TOML);
    // active candidate set = the resolved reviewers (minimax, opus).
    const candidates = resolveReviewers(config);
    expect(resolveAgentModel(config, "implement-worker", candidates)).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
    });
  });

  it("resolveAgentModel resolves investigate-explorer -> frontier -> opus -> claude", () => {
    const config = parseConfig(E2E_TOML);
    const candidates = resolveReviewers(config);
    expect(
      resolveAgentModel(config, "investigate-explorer", candidates),
    ).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
    });
  });

  it("minimax alias in [aliases] parses to the expected ReviewerToken", () => {
    const config = parseConfig(E2E_TOML);
    expect(config.aliases["minimax"]).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
    });
  });
});

// ── (2) Bare-pi rejection test ───────────────────────────────────────────────

describe("bare-pi rejection at parse/load time (T238)", () => {
  it("throws CqConfigError when [aliases] contains a bare pi token", () => {
    expect(() =>
      parseConfig(`
[aliases]
minimax = "pi:minimax-m3"
`),
    ).toThrow(CqConfigError);
  });

  it("bare pi in reviewers alias throws at parseConfig (not deferred to resolve)", () => {
    expect(() =>
      parseConfig(`
reviewers = ["minimax"]
[aliases]
minimax = "pi:minimax-m3"
`),
    ).toThrow(CqConfigError);
  });

  it("throws CqConfigError when [tiers] KEY is a bare pi token", () => {
    expect(() =>
      parseConfig(`
[tiers]
"pi:minimax-m3" = "standard"
`),
    ).toThrow(CqConfigError);
  });

  it("the CqConfigError message mentions provider qualifier or bare token", () => {
    let caught: unknown;
    try {
      parseConfig(`
[aliases]
minimax = "pi:minimax-m3"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toMatch(/provider|bare/i);
  });
});

// ── (3) Cross-layer consistency test (K50 regression guard) ──────────────────
//
// LOCAL REPLICA of tokenToChildModel from
// nix/pkg/pi-extensions/cq-subagent-dispatch.ts (T233 version).
// This function is COPIED, not imported — the extension is a standalone
// store-path file outside the cq-ledgers workspace.
//
// Signature mirrors the extension exactly:
//   tokenToChildModel(token: {harness: string, model: string})
//     -> {provider: string | null, model: string} | null
//
// Logic (T233 version):
//  - harness !== 'pi' → null (claude cannot drive a child pi process; falls back)
//  - no '/' in model → null (bare pi token — REFUSED, mirrors @cq/config THROW)
//  - empty provider or empty model half → null (empty half — REFUSED)
//  - else → {provider, model}

interface CqTokenReplica {
  harness: string;
  model: string;
}

function replicaTokenToChildModel(
  token: CqTokenReplica,
): { provider: string | null; model: string } | null {
  if (token.harness !== "pi") return null;
  const slash = token.model.indexOf("/");
  if (slash < 0) return null; // bare pi token — REFUSED (mirror @cq/config THROW)
  const provider = token.model.slice(0, slash);
  const model = token.model.slice(slash + 1);
  if (provider === "" || model === "") return null; // empty half — REFUSED
  return { provider, model };
}

/**
 * Parse a raw token string into a CqTokenReplica using the same logic as
 * parseCqToken in cq-subagent-dispatch.ts (lenient: returns null instead of
 * throwing). This is the replica's string entry point.
 */
function replicaParseCqToken(token: string): CqTokenReplica | null {
  const sep = token.indexOf(":");
  if (sep < 0) return null;
  const harness = token.slice(0, sep);
  const model = token.slice(sep + 1);
  if (harness === "" || model === "") return null;
  if (harness !== "claude" && harness !== "pi") return null;
  return { harness, model };
}

/**
 * Combined replica: parse string token then apply tokenToChildModel.
 * Returns null when either step rejects.
 */
function replicaParseAndConvert(
  token: string,
): { provider: string | null; model: string } | null {
  const cqToken = replicaParseCqToken(token);
  if (cqToken === null) return null;
  return replicaTokenToChildModel(cqToken);
}

// Fixture table for pi tokens — the core K50 regression guard.
// ACCEPT iff ACCEPT + agreement invariant applies to these rows.
const PI_ACCEPT_CASES: Array<{
  token: string;
  expectedProvider: string;
  expectedModel: string;
}> = [
  {
    token: "pi:ollama-cloud/minimax-m3",
    expectedProvider: "ollama-cloud",
    expectedModel: "minimax-m3",
  },
  {
    token: "pi:grok-build/grok-build",
    expectedProvider: "grok-build",
    expectedModel: "grok-build",
  },
];

const PI_REJECT_CASES: string[] = [
  "pi:minimax-m3", // bare pi — no provider qualifier
  "pi:p/", // empty model half
  "pi:/m", // empty provider half
];

describe("cross-layer consistency: pi tokens (K50 regression guard, T238)", () => {
  // Accepted pi tokens: parseReviewerToken ACCEPTS iff replica ACCEPTS, and agree.
  for (const { token, expectedProvider, expectedModel } of PI_ACCEPT_CASES) {
    it(`BOTH accept "${token}" and agree on provider='${expectedProvider}' model='${expectedModel}'`, () => {
      // parseReviewerToken must accept
      const parsed = parseReviewerToken(token);
      expect(parsed.harness).toBe("pi");
      expect(parsed.provider).toBe(expectedProvider);
      expect(parsed.model).toBe(expectedModel);

      // replica must also accept and agree
      const replica = replicaParseAndConvert(token);
      expect(replica).not.toBeNull();
      expect(replica!.provider).toBe(expectedProvider);
      expect(replica!.model).toBe(expectedModel);
    });
  }

  // Rejected pi tokens: parseReviewerToken THROWS and replica returns null.
  for (const token of PI_REJECT_CASES) {
    it(`BOTH refuse "${token}" — parseReviewerToken throws and replica returns null`, () => {
      // parseReviewerToken must throw
      expect(() => parseReviewerToken(token)).toThrow(CqConfigError);

      // replica must also refuse (return null)
      const replica = replicaParseAndConvert(token);
      expect(replica).toBeNull();
    });
  }
});

describe("cross-layer consistency: claude tokens (T238)", () => {
  it("claude:opus-4.8[1m] — parseReviewerToken accepts with provider:null", () => {
    const parsed = parseReviewerToken("claude:opus-4.8[1m]");
    expect(parsed.harness).toBe("claude");
    expect(parsed.model).toBe("opus-4.8[1m]");
    expect(parsed.provider).toBeNull();
  });

  it("claude:opus-4.8[1m] — replica parseCqToken recognizes the token (harness=claude, no provider)", () => {
    // parseCqToken accepts it; tokenToChildModel returns null (claude cannot
    // drive a child pi process — caller falls back to the parent model).
    const cqToken = replicaParseCqToken("claude:opus-4.8[1m]");
    expect(cqToken).not.toBeNull();
    expect(cqToken!.harness).toBe("claude");
    expect(cqToken!.model).toBe("opus-4.8[1m]");
    // tokenToChildModel returns null for any claude token
    expect(replicaTokenToChildModel(cqToken!)).toBeNull();
  });

  it("claude:x/y — parseReviewerToken THROWS (claude rejects provider qualifier)", () => {
    expect(() => parseReviewerToken("claude:x/y")).toThrow(CqConfigError);
  });

  it("claude:x/y — replica replicaParseAndConvert returns null (harness=claude falls back, no pi child model)", () => {
    // parseCqToken returns {harness:'claude', model:'x/y'}; tokenToChildModel
    // returns null (harness !== 'pi'). Both refuse to produce a usable pi child model.
    const replica = replicaParseAndConvert("claude:x/y");
    expect(replica).toBeNull();
  });
});
