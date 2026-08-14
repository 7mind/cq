/**
 * T1395 / G135 — `cq config` exposes the canonical get_config(all) payload.
 *
 * Behavioral-Active Blackbox-Atomic: dispatch is the public CLI boundary;
 * config parsing and harness selection execute through the production shared
 * computation without a ledger-store dependency.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GetConfigResult } from "@cq/ledger";
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

async function dispatchConfig(root: string): Promise<{
  readonly outcome: Awaited<ReturnType<typeof dispatch>>;
  readonly io: RecordingIo;
}> {
  const io = recordingIo();
  const outcome = await dispatch(["config", "--cwd", root], io);
  return { outcome, io };
}

beforeAll(async () => {
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
