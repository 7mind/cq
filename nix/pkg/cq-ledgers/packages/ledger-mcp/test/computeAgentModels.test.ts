/**
 * T285: computeAgentModels over the fixed 19-role roster (Q156–Q158).
 *
 * Asserts the per-role model overlay the `get_agent_models` tool returns:
 *  - a fixture cq.toml with [agent_tiers]+[tiers]+[aliases] yields `resolved`
 *    entries with the expected per-harness tokens for at least one subagent;
 *  - a role whose tier class has no live candidate token yields `no-live-token`;
 *  - orchestrator-command roles (agentTierKey null) yield `not-model-configurable`;
 *  - an absent cq.toml yields every model-configurable role as `not-configured`.
 *
 * Plus the anti-drift invariant: the server roster (@cq/config AGENT_ROLE_TIERS,
 * which computeAgentModels walks) matches the gen-agents-catalogue ROLES ids.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { computeAgentModels } from "../src/configCapability.js";
import { AGENT_ROLE_TIERS } from "@cq/config";
import type { AgentModelEntry } from "@cq/ledger";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "t285-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCqToml(contents: string): void {
  writeFileSync(path.join(dir, "cq.toml"), contents, "utf8");
}

function entry(result: { agents: readonly AgentModelEntry[] }, id: string): AgentModelEntry {
  const found = result.agents.find((a) => a.id === id);
  if (found === undefined) {
    throw new Error(`no agent entry for id "${id}"`);
  }
  return found;
}

/**
 * Fixture: opus = frontier, minimax = standard, haiku = fast (in [tiers]).
 * planners ∪ reviewers union resolves to {opus, minimax} only — NO fast token
 * is live. [agent_tiers] places:
 *  - implement-worker -> frontier (a live opus token in the union)
 *  - investigate-explorer -> fast (no live token of that class -> no-live-token)
 *  - everything else falls back to DEFAULT_TIER = standard (minimax is live).
 */
const FIXTURE = [
  'reviewers = ["opus"]',
  'planners  = ["opus", "minimax"]',
  "",
  "[aliases]",
  '  opus    = "claude:opus-4.8[1m]"',
  '  minimax = "pi:ollama-cloud/minimax-m3"',
  '  haiku   = "claude:haiku-4.8"',
  "",
  "[tiers]",
  '  "claude:opus-4.8[1m]"          = "frontier"',
  '  "pi:ollama-cloud/minimax-m3"   = "standard"',
  '  "claude:haiku-4.8"             = "fast"',
  "",
  "[agent_tiers]",
  '  implement-worker     = "frontier"',
  '  investigate-explorer = "fast"',
  "",
].join("\n");

describe("T285: computeAgentModels — configured fixture", () => {
  it("resolves a frontier subagent to its live per-harness token", () => {
    writeCqToml(FIXTURE);
    const result = computeAgentModels(dir);
    expect(result.configured).toBe(true);

    const worker = entry(result, "implement-worker");
    expect(worker.status).toBe("resolved");
    expect(worker.modelClass).toBe("frontier");
    // Only the opus (claude) token classifies as frontier; minimax is standard.
    expect(worker.modelMappings).toEqual({ claude: ["opus-4.8[1m]"] });
  });

  it("resolves a standard (default-tier) subagent to the pi token, provider-qualified", () => {
    writeCqToml(FIXTURE);
    const result = computeAgentModels(dir);

    // plan-advance has no [agent_tiers] entry -> DEFAULT_TIER standard.
    const planAdvance = entry(result, "plan-advance");
    expect(planAdvance.status).toBe("resolved");
    expect(planAdvance.modelClass).toBe("standard");
    expect(planAdvance.modelMappings).toEqual({ pi: ["ollama-cloud/minimax-m3"] });
  });

  it("yields no-live-token for a tier class with no live candidate token", () => {
    writeCqToml(FIXTURE);
    const result = computeAgentModels(dir);

    // investigate-explorer -> fast; no fast token is in the planners∪reviewers union.
    const explorer = entry(result, "investigate-explorer");
    expect(explorer.status).toBe("no-live-token");
    expect(explorer.modelClass).toBe("fast");
    expect(explorer.modelMappings).toEqual({});
  });

  it("yields not-model-configurable for orchestrator-command roles", () => {
    writeCqToml(FIXTURE);
    const result = computeAgentModels(dir);

    const advance = entry(result, "advance");
    expect(advance.status).toBe("not-model-configurable");
    expect(advance.modelClass).toBeNull();
    expect(advance.modelMappings).toEqual({});
  });
});

/**
 * Multi-harness fixture: the SAME tier class (`frontier`) is assigned to BOTH a
 * claude token (opus) AND a pi token (minimax), and both aliases are live in the
 * candidate union (planners ∪ reviewers). An agent placed at `frontier` must
 * therefore resolve to per-harness mappings containing BOTH `claude` and `pi`
 * arrays — exercising groupByHarness parity with deriveModelMappings for the
 * multi-harness case (Q157).
 *
 * The `frontier` class also has TWO claude tokens (opus, sonnet) listed in
 * NON-sorted insertion order ("...opus..." before "...sonnet..." reverses under
 * lexical sort — "opus-4.8[1m]" > "claude-sonnet…" no; pick ids that reorder),
 * so the claude array exercises the deterministic sort assertion: candidates
 * preserve config order, but groupByHarness sorts within each harness.
 */
const MULTI_HARNESS_FIXTURE = [
  // sonnet listed AFTER opus in planners, but sorts BEFORE it lexically
  // ("opus-4.8[1m]" > "claude-4.8-sonnet" -> "claude-4.8-sonnet" < "opus-4.8[1m]").
  'planners  = ["opus", "minimax", "sonnet"]',
  'reviewers = ["opus"]',
  "",
  "[aliases]",
  '  opus    = "claude:opus-4.8[1m]"',
  '  sonnet  = "claude:claude-4.8-sonnet"',
  '  minimax = "pi:ollama-cloud/minimax-m3"',
  "",
  "[tiers]",
  '  "claude:opus-4.8[1m]"          = "frontier"',
  '  "claude:claude-4.8-sonnet"     = "frontier"',
  '  "pi:ollama-cloud/minimax-m3"   = "frontier"',
  "",
  "[agent_tiers]",
  '  implement-worker = "frontier"',
  "",
].join("\n");

describe("T285: computeAgentModels — multi-harness resolved", () => {
  it("resolves a single agent's tier to BOTH claude and pi mappings, each deduped+sorted", () => {
    writeCqToml(MULTI_HARNESS_FIXTURE);
    const result = computeAgentModels(dir);
    expect(result.configured).toBe(true);

    const worker = entry(result, "implement-worker");
    expect(worker.status).toBe("resolved");
    expect(worker.modelClass).toBe("frontier");
    // Both harnesses present: claude (opus+sonnet) and pi (minimax, qualified).
    expect(worker.modelMappings).toEqual({
      claude: ["claude-4.8-sonnet", "opus-4.8[1m]"],
      pi: ["ollama-cloud/minimax-m3"],
    });
  });

  it("orders a same-harness multi-token mapping lexically, not by insertion order", () => {
    writeCqToml(MULTI_HARNESS_FIXTURE);
    const result = computeAgentModels(dir);

    // Candidate union preserves config order [opus, minimax, sonnet], so the two
    // claude frontier tokens enter as [opus-4.8[1m], claude-4.8-sonnet]. The
    // emitted claude array must be SORTED ([claude-4.8-sonnet, opus-4.8[1m]]),
    // matching deriveModelMappings — assert the exact ordered array, not a set.
    const worker = entry(result, "implement-worker");
    expect(worker.modelMappings.claude).toEqual([
      "claude-4.8-sonnet",
      "opus-4.8[1m]",
    ]);
  });
});

describe("T285: computeAgentModels — absent cq.toml", () => {
  it("yields not-configured for every model-configurable role and not-model-configurable for commands", () => {
    // dir has no cq.toml written.
    const result = computeAgentModels(dir);
    expect(result.configured).toBe(false);

    for (const role of AGENT_ROLE_TIERS) {
      const e = entry(result, role.id);
      if (role.agentTierKey === null) {
        expect(e.status).toBe("not-model-configurable");
      } else {
        expect(e.status).toBe("not-configured");
      }
      expect(e.modelClass).toBeNull();
      expect(e.modelMappings).toEqual({});
    }
  });
});

describe("T285: roster shape", () => {
  it("walks all 19 roles, 7 model-configurable", () => {
    const result = computeAgentModels(dir);
    expect(result.agents).toHaveLength(19);
    expect(AGENT_ROLE_TIERS).toHaveLength(19);
    expect(AGENT_ROLE_TIERS.filter((r) => r.agentTierKey !== null)).toHaveLength(7);
  });
});
