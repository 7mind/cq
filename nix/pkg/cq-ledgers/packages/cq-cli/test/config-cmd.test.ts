/**
 * T1395 / G135 — `cq config` exposes the canonical get_config(all) payload.
 *
 * Behavioral-Active Blackbox-Atomic: dispatch is the public CLI boundary;
 * config parsing and harness selection execute through the production shared
 * computation without a ledger-store dependency.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GetConfigResult } from "@cq/ledger";
import { resolveGlobalConfigPath } from "@cq/config";
import { computeSection } from "../../ledger-mcp/src/configCapability.js";
import {
  dispatch,
  USAGE,
  type ConfirmIo,
  type DispatchIo,
} from "../src/main.js";

const FIXTURE = [
  'reviewers = ["opus"]',
  'planners = ["opus"]',
  "",
  "[aliases]",
  'opus = "claude:opus-4.8[1m]"',
  'grok = "pi:grok-build/grok-build"',
  "",
  "[tiers]",
  'frontier = "opus"',
  "",
  "[agent_tiers]",
  'plan-advance = "frontier"',
  "",
  "[agent_efforts]",
  'plan-advance = "high"',
  "",
  "[harness.pi]",
  'reviewers = ["grok"]',
  'planners = ["grok"]',
  "",
  "[harness.pi.tiers]",
  'frontier = "grok"',
  "",
].join("\n");

const roots: string[] = [];
const originalHarness = process.env["CQ_HARNESS"];
const originalConfigHome = process.env["XDG_CONFIG_HOME"];

const silentConfirm: ConfirmIo = {
  isTty: false,
  out: () => {},
  err: () => {},
  prompt: async () => "",
};

interface RecordingIo extends DispatchIo {
  readonly outs: string[];
  readonly errs: string[];
}

function recordingIo(): RecordingIo {
  const outs: string[] = [];
  const errs: string[] = [];
  return {
    outs,
    errs,
    out: (line) => outs.push(line),
    err: (line) => errs.push(line),
    confirm: silentConfirm,
  };
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeGlobal(source: string): Promise<string> {
  const configPath = resolveGlobalConfigPath(process.env, "/unused-home");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, source, "utf8");
  return configPath;
}

async function dispatchConfig(root: string): Promise<{
  readonly outcome: Awaited<ReturnType<typeof dispatch>>;
  readonly io: RecordingIo;
}> {
  const io = recordingIo();
  const outcome = await dispatch(["config", "--cwd", root], io);
  return { outcome, io };
}

beforeEach(async () => {
  process.env["CQ_HARNESS"] = "pi";
  process.env["XDG_CONFIG_HOME"] = await makeRoot("cq-config-cmd-xdg-");
});

afterAll(async () => {
  if (originalHarness === undefined) delete process.env["CQ_HARNESS"];
  else process.env["CQ_HARNESS"] = originalHarness;
  if (originalConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = originalConfigHome;
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("cq config", () => {
  it("emits one JSON object exactly equal to get_config(all) for the active harness", async () => {
    const root = await makeRoot("cq-config-cmd-valid-");
    await writeFile(path.join(root, "cq.toml"), FIXTURE, "utf8");

    const expected = computeSection(root, "all") as GetConfigResult;
    const { outcome, io } = await dispatchConfig(root);

    expect(outcome).toEqual({ exitCode: 0, longRunning: false });
    expect(io.errs).toEqual([]);
    expect(io.outs).toHaveLength(1);
    expect(JSON.parse(io.outs[0]!) as GetConfigResult).toEqual(expected);
    expect(expected.configured).toBe(true);
    expect(expected.planners).toEqual(["grok"]);
    expect(expected.tiers?.frontier?.harness).toBe("pi");
    expect(expected.agentTiers?.["plan-advance"]).toBe("frontier");
    expect(expected.agentEfforts["plan-advance"]).toBe("high");
  });

  it("emits configured:false with empty stderr when neither config file exists", async () => {
    const root = await makeRoot("cq-config-cmd-empty-");

    const { outcome, io } = await dispatchConfig(root);

    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);
    expect(io.outs).toHaveLength(1);
    expect((JSON.parse(io.outs[0]!) as GetConfigResult).configured).toBe(false);
  });

  it("fails without JSON stdout for malformed and schema-invalid TOML", async () => {
    const fixtures = [
      '[aliases\ngrok = "pi:grok-build/grok-build"',
      "[webui]\nport = 0\n",
    ];

    for (const fixture of fixtures) {
      const root = await makeRoot("cq-config-cmd-invalid-");
      await writeFile(path.join(root, "cq.toml"), fixture, "utf8");

      const { outcome, io } = await dispatchConfig(root);

      expect(outcome.exitCode).toBe(1);
      expect(io.errs.join("\n").length).toBeGreaterThan(0);
      expect(io.outs).toEqual([]);
    }
  });

  it("fails without JSON stdout when cq.toml cannot be read", async () => {
    const root = await makeRoot("cq-config-cmd-unreadable-");
    const configPath = path.join(root, "cq.toml");
    await writeFile(configPath, FIXTURE, "utf8");
    await chmod(configPath, 0o000);

    try {
      const { outcome, io } = await dispatchConfig(root);
      expect(outcome.exitCode).toBe(1);
      expect(io.errs.join("\n").length).toBeGreaterThan(0);
      expect(io.outs).toEqual([]);
    } finally {
      await chmod(configPath, 0o600);
    }
  });

  it("documents the native subcommand and its cwd carrier", () => {
    expect(USAGE).toContain("  config      [--cwd <path>]");
  });
});

// These merge assertions were intentionally expected to fail before M572
// moved global discovery into loadConfig. T1396 keeps that sequencing visible
// while pinning the now-live post-M572 contract at the public CLI boundary.
describe("cq config global/local composition", () => {
  it("emits byte-identical get_config(all) JSON for a global-only config", async () => {
    const root = await makeRoot("cq-config-cmd-global-only-");
    await writeGlobal(FIXTURE);

    const expected = computeSection(root, "all") as GetConfigResult;
    const { outcome, io } = await dispatchConfig(root);

    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);
    expect(io.outs).toEqual([JSON.stringify(expected)]);
    expect(expected.configured).toBe(true);
    expect(expected.planners).toEqual(["grok"]);
  });

  it("applies local precedence to aliases, tiers, and agent tiers", async () => {
    const root = await makeRoot("cq-config-cmd-merged-");
    await writeGlobal([
      'reviewers = ["globalReviewer"]',
      'planners = ["globalPlanner"]',
      "",
      "[aliases]",
      'globalReviewer = "pi:global/reviewer"',
      'globalPlanner = "pi:global/planner"',
      'globalOnly = "pi:global/only"',
      'shared = "pi:global/shared"',
      "",
      "[tiers]",
      'fast = "globalOnly"',
      'standard = "shared"',
      "",
      "[agent_tiers]",
      'globalAgent = "fast"',
      'sharedAgent = "fast"',
      "",
    ].join("\n"));
    await writeFile(path.join(root, "cq.toml"), [
      'reviewers = ["localReviewer"]',
      "",
      "[aliases]",
      'localReviewer = "pi:local/reviewer"',
      'localOnly = "pi:local/only"',
      'shared = "pi:local/shared"',
      "",
      "[tiers]",
      'standard = "shared"',
      'frontier = "localOnly"',
      "",
      "[agent_tiers]",
      'localAgent = "standard"',
      'sharedAgent = "frontier"',
      "",
    ].join("\n"), "utf8");

    const expected = computeSection(root, "all") as GetConfigResult;
    const { outcome, io } = await dispatchConfig(root);

    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);
    expect(io.outs).toEqual([JSON.stringify(expected)]);
    expect(expected.reviewers).toEqual(["localReviewer"]);
    expect(expected.planners).toEqual(["globalPlanner"]);
    expect(expected.aliases.shared).toMatchObject({ provider: "local", model: "shared" });
    expect(expected.aliases.globalOnly).toMatchObject({ provider: "global", model: "only" });
    expect(expected.aliases.localOnly).toMatchObject({ provider: "local", model: "only" });
    expect(expected.tiers).toMatchObject({
      fast: { provider: "global", model: "only" },
      standard: { provider: "local", model: "shared" },
      frontier: { provider: "local", model: "only" },
    });
    expect(expected.agentTiers).toEqual({
      globalAgent: "fast",
      sharedAgent: "frontier",
      localAgent: "standard",
    });
  });

  it("fails closed on malformed local TOML even when global TOML is valid", async () => {
    const root = await makeRoot("cq-config-cmd-bad-local-");
    await writeGlobal(FIXTURE);
    const localPath = path.join(root, "cq.toml");
    await writeFile(localPath, "[aliases\ninvalid = true", "utf8");

    const { outcome, io } = await dispatchConfig(root);

    expect(outcome.exitCode).toBe(1);
    expect(io.outs).toEqual([]);
    expect(io.errs.join("\n")).toContain(localPath);
  });

  it("fails closed on malformed global TOML even when local TOML is valid", async () => {
    const root = await makeRoot("cq-config-cmd-bad-global-");
    const globalPath = await writeGlobal("[aliases\ninvalid = true");
    await writeFile(path.join(root, "cq.toml"), FIXTURE, "utf8");

    const { outcome, io } = await dispatchConfig(root);

    expect(outcome.exitCode).toBe(1);
    expect(io.outs).toEqual([]);
    expect(io.errs.join("\n")).toContain(globalPath);
  });
});
