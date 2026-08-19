/**
 * T1379: global cq.toml composition reaches the public get_config capability.
 *
 * Behavioral-Active / Blackbox-Group: the assertions invoke the real MCP tool
 * definition over an initialized store and observe only its wire DTO.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryLedgerStore,
  createLedgerMcpTools,
  type AgentModelsResult,
  type GetConfigResult,
  type GetPlannersResult,
  type GetReviewersResult,
} from "@cq/ledger";
import { resolveGlobalConfigPath } from "@cq/config";
import { createConfigCapability } from "../src/configCapability.js";

type TextResult = { content: Array<{ type: string; text: string }> };

const originalConfigHome = process.env["XDG_CONFIG_HOME"];
const originalHarness = process.env["CQ_HARNESS"];

let configHome: string;
let repoRoot: string;
let store: InMemoryLedgerStore;

beforeEach(async () => {
  configHome = await mkdtemp(path.join(tmpdir(), "cq-global-config-home-"));
  repoRoot = await mkdtemp(path.join(tmpdir(), "cq-global-config-repo-"));
  process.env["XDG_CONFIG_HOME"] = configHome;
  process.env["CQ_HARNESS"] = "pi";
  store = new InMemoryLedgerStore();
  await store.init();
});

afterEach(async () => {
  await store.dispose();
  await Promise.all([
    rm(configHome, { recursive: true, force: true }),
    rm(repoRoot, { recursive: true, force: true }),
  ]);
  restoreEnvironment("XDG_CONFIG_HOME", originalConfigHome);
  restoreEnvironment("CQ_HARNESS", originalHarness);
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function writeGlobalConfig(contents: string): Promise<void> {
  const configPath = resolveGlobalConfigPath(process.env, "/unused-home");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, contents, "utf8");
}

async function writeLocalConfig(contents: string): Promise<void> {
  await writeFile(path.join(repoRoot, "cq.toml"), contents, "utf8");
}

async function getConfig<T>(section: string): Promise<T> {
  const tools = createLedgerMcpTools(
    store,
    undefined,
    createConfigCapability(repoRoot),
  );
  const tool = tools.find((candidate) => candidate.name === "get_config");
  if (tool === undefined) throw new Error("get_config tool not found");
  const result = (await tool.handler({ section } as never, null)) as TextResult;
  const content = result.content[0];
  if (content === undefined || content.type !== "text") {
    throw new Error("get_config returned no text content");
  }
  return JSON.parse(content.text) as T;
}

function globalConfig(): string {
  return [
    'reviewers = ["globalReviewer"]',
    'planners = ["globalPlanner"]',
    "",
    "[aliases]",
    'globalReviewer = "pi:global/reviewer"',
    'globalPlanner = "pi:global/planner"',
    'globalFast = "pi:global/fast"',
    'globalStandard = "pi:global/standard"',
    'globalFrontier = "pi:global/frontier"',
    "",
    "[tiers]",
    'fast = "globalFast"',
    'standard = "globalStandard"',
    'frontier = "globalFrontier"',
    "",
    "[agent_tiers]",
    'implement-worker = "frontier"',
    "",
    "[agent_efforts]",
    'implement-worker = "high"',
    "",
    "[ledger]",
    'backend = "remote"',
    'serverUrl = "https://GLOBAL_LEDGER_SENTINEL.invalid"',
    'projectId = "GLOBAL_PROJECT_ID_SENTINEL"',
    "",
    "[project]",
    'name = "GLOBAL_PROJECT_NAME_SENTINEL"',
    "",
  ].join("\n");
}

describe("T1379: get_config inherits global cq.toml composition", () => {
  it("serves global-only panels, tiers, aliases, and agent models", async () => {
    await writeGlobalConfig(globalConfig());

    const all = await getConfig<GetConfigResult>("all");
    const reviewers = await getConfig<GetReviewersResult>("reviewers");
    const planners = await getConfig<GetPlannersResult>("planners");
    const agentModels = await getConfig<AgentModelsResult>("agent_models");

    expect(all.configured).toBe(true);
    expect(all.reviewers).toEqual(["globalReviewer"]);
    expect(all.planners).toEqual(["globalPlanner"]);
    expect(all.aliases["globalFrontier"]).toEqual({
      harness: "pi",
      model: "frontier",
      provider: "global",
      effort: null,
    });
    expect(reviewers).toEqual({
      configured: true,
      source: "cq.toml",
      reviewers: [{
        harness: "pi",
        model: "reviewer",
        provider: "global",
        alias: "globalReviewer",
        effort: null,
      }],
    });
    expect(planners).toEqual({
      configured: true,
      source: "cq.toml",
      planners: [{
        harness: "pi",
        model: "planner",
        provider: "global",
        alias: "globalPlanner",
        effort: null,
      }],
    });
    expect(agentModels.configured).toBe(true);
    expect(agentModels.agents.find((agent) => agent.id === "implement-worker")).toEqual({
      id: "implement-worker",
      status: "resolved",
      modelClass: "frontier",
      modelMappings: { pi: ["global/frontier:high"] },
    });

    const wire = JSON.stringify({ all, reviewers, planners, agentModels });
    expect(wire).not.toContain("GLOBAL_LEDGER_SENTINEL");
    expect(wire).not.toContain("GLOBAL_PROJECT_ID_SENTINEL");
    expect(wire).not.toContain("GLOBAL_PROJECT_NAME_SENTINEL");
  });

  it("applies local precedence while retaining global fallback keys", async () => {
    await writeGlobalConfig(globalConfig());
    await writeLocalConfig([
      'reviewers = ["localReviewer"]',
      "",
      "[aliases]",
      'localReviewer = "pi:local/reviewer"',
      'localFast = "pi:local/fast"',
      "",
      "[tiers]",
      'fast = "localFast"',
      "",
      "[agent_tiers]",
      'implement-worker = "fast"',
      "",
      "[agent_efforts]",
      'implement-worker = "low"',
      "",
    ].join("\n"));

    const all = await getConfig<GetConfigResult>("all");
    const reviewers = await getConfig<GetReviewersResult>("reviewers");
    const planners = await getConfig<GetPlannersResult>("planners");
    const agentModels = await getConfig<AgentModelsResult>("agent_models");

    expect(all.configured).toBe(true);
    expect(all.reviewers).toEqual(["localReviewer"]);
    expect(all.planners).toEqual(["globalPlanner"]);
    expect(all.tiers).toEqual({
      fast: { harness: "pi", model: "fast", provider: "local", effort: null },
      standard: { harness: "pi", model: "standard", provider: "global", effort: null },
      frontier: { harness: "pi", model: "frontier", provider: "global", effort: null },
    });
    expect(reviewers.reviewers[0]?.alias).toBe("localReviewer");
    expect(planners.planners[0]?.alias).toBe("globalPlanner");
    expect(agentModels.agents.find((agent) => agent.id === "implement-worker")).toEqual({
      id: "implement-worker",
      status: "resolved",
      modelClass: "fast",
      modelMappings: { pi: ["local/fast:low"] },
    });
  });
});
