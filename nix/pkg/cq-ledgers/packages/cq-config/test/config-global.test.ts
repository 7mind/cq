/** T1377 global cq.toml discovery and merge contract. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CqConfigError,
  loadConfig,
  parseConfig,
  parseReviewerToken,
  resolveGlobalConfigPath,
} from "../src/index.js";

let localRoot: string;
let xdgConfigHome: string;
let originalXdgConfigHome: string | undefined;

beforeEach(() => {
  localRoot = mkdtempSync(path.join(tmpdir(), "cq-config-local-"));
  xdgConfigHome = mkdtempSync(path.join(tmpdir(), "cq-config-xdg-"));
  originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
});

afterEach(() => {
  rmSync(localRoot, { recursive: true, force: true });
  rmSync(xdgConfigHome, { recursive: true, force: true });
  if (originalXdgConfigHome === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
  }
});

function writeLocal(source: string): string {
  const file = path.join(localRoot, "cq.toml");
  writeFileSync(file, source, "utf8");
  return file;
}

function writeGlobal(source: string): string {
  const file = resolveGlobalConfigPath(process.env, "/unused-home");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source, "utf8");
  return file;
}

const GLOBAL_ONLY = `
reviewers = ["global"]
planners = ["global"]

[aliases]
global = "claude:global-model"

[tiers]
standard = "global"

[dispatch]
forceShellout = true
`;

const LOCAL_ONLY = `
reviewers = ["local"]
planners = ["local"]

[aliases]
local = "pi:local/local-model"

[tiers]
standard = "local"
`;

describe("loadConfig global discovery and precedence [BG]", () => {
  it("loads a global-only cq.toml when the local file is absent", () => {
    writeGlobal(GLOBAL_ONLY);

    expect(loadConfig(localRoot, "pi")).toEqual(parseConfig(GLOBAL_ONLY, "pi"));
  });

  it("keeps local-only loading byte-for-byte equivalent to parseConfig", () => {
    writeLocal(LOCAL_ONLY);

    expect(loadConfig(localRoot, "pi")).toEqual(parseConfig(LOCAL_ONLY, "pi"));
  });

  it("merges global and local sections with local precedence", () => {
    writeGlobal(`
reviewers = ["globalReviewer"]
planners = ["globalPlanner"]

[aliases]
globalReviewer = "claude:global-reviewer"
globalPlanner = "claude:global-planner"
globalOnly = "claude:global-only"
globalHarnessReviewer = "pi:global/harness-reviewer"
shared = "claude:global-shared"

[tiers]
fast = "globalOnly"
standard = "shared"

[agent_tiers]
globalAgent = "fast"
sharedAgent = "fast"

[agent_efforts]
globalAgent = "low"
sharedAgent = "low"

[webui]
host = "global.example"
port = 7000

[dispatch]
forceShellout = true

[harness.pi]
reviewers = ["globalHarnessReviewer"]

[harness.pi.tiers]
fast = "globalHarnessReviewer"

[ledger]
backend = "remote"
serverUrl = "https://global-ledger.example"
projectId = "global-project"

[project]
name = "Global project"
`);
    writeLocal(`
reviewers = ["localReviewer"]

[aliases]
localReviewer = "claude:local-reviewer"
localPlanner = "pi:local/planner"
localOnly = "pi:local/only"
shared = "claude:local-shared"

[tiers]
standard = "shared"
frontier = "localOnly"

[agent_tiers]
localAgent = "standard"
sharedAgent = "frontier"

[agent_efforts]
localAgent = "medium"
sharedAgent = "high"

[webui]
port = 8814

[harness.pi]
planners = ["localPlanner"]
`);

    const shared = loadConfig(localRoot, "claude");
    expect(shared).not.toBeNull();
    expect(shared!.aliases).toEqual({
      globalReviewer: parseReviewerToken("claude:global-reviewer"),
      globalPlanner: parseReviewerToken("claude:global-planner"),
      globalOnly: parseReviewerToken("claude:global-only"),
      globalHarnessReviewer: parseReviewerToken("pi:global/harness-reviewer"),
      shared: parseReviewerToken("claude:local-shared"),
      localReviewer: parseReviewerToken("claude:local-reviewer"),
      localPlanner: parseReviewerToken("pi:local/planner"),
      localOnly: parseReviewerToken("pi:local/only"),
    });
    expect(shared!.reviewers).toEqual(["localReviewer"]);
    expect(shared!.planners).toEqual(["globalPlanner"]);
    expect(shared!.tiers?.entries).toEqual([
      {
        class: "fast",
        raw: "globalOnly",
        token: parseReviewerToken("claude:global-only"),
      },
      {
        class: "standard",
        raw: "shared",
        token: parseReviewerToken("claude:local-shared"),
      },
      {
        class: "frontier",
        raw: "localOnly",
        token: parseReviewerToken("pi:local/only"),
      },
    ]);
    expect(shared!.agentTiers).toEqual({
      globalAgent: "fast",
      sharedAgent: "frontier",
      localAgent: "standard",
    });
    expect(shared!.agentEfforts).toEqual({
      globalAgent: "low",
      sharedAgent: "high",
      localAgent: "medium",
    });
    expect(shared!.webui).toEqual({ host: null, port: 8814 });
    expect(shared!.dispatch).toEqual({ forceShellout: true });
    expect(shared!.ledger).toBeNull();
    expect(shared!.project).toBeNull();

    const pi = loadConfig(localRoot, "pi");
    expect(pi?.reviewers).toEqual(["globalHarnessReviewer"]);
    expect(pi?.planners).toEqual(["localPlanner"]);
    expect(pi?.tiers?.entries).toEqual([
      {
        class: "fast",
        raw: "globalHarnessReviewer",
        token: parseReviewerToken("pi:global/harness-reviewer"),
      },
    ]);
  });

  it("ignores global ledger and project tables while preserving local tables", () => {
    writeGlobal(`
[ledger]
backend = "remote"
serverUrl = "https://global-ledger.example"
url = "postgresql://global.example/cq"
projectId = "global-project"

[project]
name = "Global project"
`);
    writeLocal(LOCAL_ONLY);

    const withoutLocalTables = loadConfig(localRoot, "pi");
    expect(withoutLocalTables?.ledger).toBeNull();
    expect(withoutLocalTables?.project).toBeNull();

    writeLocal(`${LOCAL_ONLY}
[ledger]
backend = "xdg"
backup = "in-tree"
projectId = "local-project"

[project]
name = "Local project"
`);
    const withLocalTables = loadConfig(localRoot, "pi");
    expect(withLocalTables?.ledger).toEqual({
      backend: "xdg",
      backendExplicit: true,
      branch: "cq-ledger",
      remote: "origin",
      backup: "in-tree",
      projectId: "local-project",
      url: null,
      serverUrl: null,
    });
    expect(withLocalTables?.project).toEqual({ name: "Local project" });
  });

  it("returns null when global and local files are both absent", () => {
    expect(loadConfig(localRoot, "pi")).toBeNull();
  });

  it("names the malformed global file's absolute path", () => {
    const globalFile = writeGlobal("[aliases\ninvalid = true");

    expect(() => loadConfig(localRoot, "pi")).toThrow(globalFile);
  });

  it("names the malformed local file's absolute path", () => {
    writeGlobal(GLOBAL_ONLY);
    const localFile = writeLocal("[aliases\ninvalid = true");

    expect(() => loadConfig(localRoot, "pi")).toThrow(localFile);
  });

  it("names both source paths when their merged schema is invalid", () => {
    const globalFile = writeGlobal(`
reviewers = ["shared"]

[aliases]
shared = "claude:global-model"
`);
    const localFile = writeLocal(`
[aliases]
shared = "unknown:local-model"
`);

    let failure: unknown;
    try {
      loadConfig(localRoot, "pi");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CqConfigError);
    expect((failure as Error).message).toContain(globalFile);
    expect((failure as Error).message).toContain(localFile);
  });
});
