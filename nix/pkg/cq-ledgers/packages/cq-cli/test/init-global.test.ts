/** T1384: global cq.toml scaffolding [Behavioral-Active/Blackbox-GoodCommunication]. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadConfig, parseConfig, resolveGlobalConfigPath } from "@cq/config";
import {
  CQ_TOML_GLOBAL_TEMPLATE,
} from "../src/cqTomlTemplate.js";
import {
  CQ_CONFIG_FILENAME,
  dispatch,
  type ConfirmIo,
  type DispatchIo,
} from "../src/main.js";

const silentConfirm: ConfirmIo = {
  isTty: false,
  out: () => {},
  err: () => {},
  prompt: async () => "",
};

function recordingIo(): DispatchIo & { outs: string[] } {
  const outs: string[] = [];
  return {
    outs,
    out: (line) => outs.push(line),
    err: () => {},
    confirm: silentConfirm,
  };
}

describe("cq init --global", () => {
  let base: string;
  let projectRoot: string;
  let xdgConfigHome: string;
  let xdgStateHome: string;
  let originalXdgConfigHome: string | undefined;
  let originalXdgStateHome: string | undefined;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "cq-init-global-"));
    projectRoot = path.join(base, "not-a-git-repository");
    xdgConfigHome = path.join(base, "config");
    xdgStateHome = path.join(base, "state");
    await mkdir(projectRoot);
    originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    process.env["XDG_STATE_HOME"] = xdgStateHome;
  });

  afterEach(async () => {
    if (originalXdgConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
    if (originalXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = originalXdgStateHome;
    await rm(base, { recursive: true, force: true });
  });

  it("writes only the global harness config without project identity or ledger state", async () => {
    const outcome = await dispatch(["init", "--global", "--cwd", projectRoot], recordingIo());
    expect(outcome).toEqual({ exitCode: 0, longRunning: false });

    const globalPath = resolveGlobalConfigPath(process.env, "/unused-home");
    const source = await readFile(globalPath, "utf8");
    expect(source).toBe(CQ_TOML_GLOBAL_TEMPLATE);
    expect(() => parseConfig(source)).not.toThrow();
    expect(source).toContain("[aliases]");
    expect(source).toContain("[harness.claude]");
    expect(source).toContain("[ledger] and [project] are LOCAL-ONLY");
    expect(source).not.toMatch(/^\[ledger\]$/m);
    expect(source).not.toMatch(/^\[project\]$/m);
    const loaded = loadConfig(projectRoot, "claude");
    expect(loaded?.ledger).toBeNull();
    expect(loaded?.reviewers.length).toBeGreaterThan(0);
    expect(loaded?.planners.length).toBeGreaterThan(0);
    expect(loaded?.tiers?.entries.length).toBeGreaterThan(0);
    await expect(stat(path.join(projectRoot, CQ_CONFIG_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(xdgStateHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an existing file unless --force requests an exact template rewrite", async () => {
    await dispatch(["init", "--global", "--cwd", projectRoot], recordingIo());
    const globalPath = resolveGlobalConfigPath(process.env, "/unused-home");
    await writeFile(globalPath, "# retained\n", "utf8");

    const skipped = recordingIo();
    expect(await dispatch(["init", "--global", "--cwd", projectRoot], skipped)).toEqual({
      exitCode: 0,
      longRunning: false,
    });
    expect(await readFile(globalPath, "utf8")).toBe("# retained\n");
    expect(skipped.outs.join("\n")).toContain("already exists");
    expect(skipped.outs.join("\n")).toContain("--force");

    const forced = recordingIo();
    expect(
      await dispatch(["init", "--global", "--cwd", projectRoot, "--force"], forced),
    ).toEqual({ exitCode: 0, longRunning: false });
    expect(await readFile(globalPath, "utf8")).not.toBe("# retained\n");
    expect(await readFile(globalPath, "utf8")).toBe(CQ_TOML_GLOBAL_TEMPLATE);
    expect(forced.outs.join("\n")).toContain("overwrote");
    await expect(stat(path.join(projectRoot, CQ_CONFIG_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(xdgStateHome)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
