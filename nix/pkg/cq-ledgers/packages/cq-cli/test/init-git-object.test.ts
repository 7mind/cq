/**
 * T505: `cq init` with a cq.toml naming a LEGACY backend.
 *
 * The legacy in-tree backends (fs / git-object) are no longer selectable
 * runtime primaries: `cq init` on a root whose cq.toml names one fails fast
 * with the documented LegacyBackendError pointing at `cq migrate`, and writes
 * NOTHING (no .cq/ tree, no orphan ref). (Historically these tests asserted
 * the git-object init path — see git history / T357.)
 *
 * Throwaway repos via mkdtemp; cleaned up in afterAll.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { LegacyBackendError } from "@cq/ledger";
import { dispatch, type ConfirmIo, type DispatchIo } from "../src/main.js";

const exec = promisify(execFile);
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const silentConfirm: ConfirmIo = {
  isTty: false,
  out: () => {},
  err: () => {},
  prompt: async () => "",
};

function recordingIo(): DispatchIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { outs, errs, out: (l) => outs.push(l), err: (l) => errs.push(l), confirm: silentConfirm };
}

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-init-git-"));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# repo\n");
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("cq init — legacy backends rejected (T505)", () => {
  it("backend='git-object' rejects with LegacyBackendError naming cq migrate; nothing is written", async () => {
    const root = await gitRepo();
    // A pre-existing cq.toml selecting the legacy git-object backend.
    await writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "git-object"\n', "utf8");

    const err = await dispatch(["init", "--cwd", root], recordingIo()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LegacyBackendError);
    expect((err as Error).message).toContain("cq migrate");

    // Nothing was written: no .cq/ tree, no orphan ref.
    await expect(stat(path.join(root, ".cq"))).rejects.toThrow();
    const refExists = await exec(
      "git",
      ["rev-parse", "--verify", "-q", "refs/heads/cq-ledger"],
      { cwd: root, encoding: "utf8" },
    ).then(
      () => true,
      () => false,
    );
    expect(refExists).toBe(false);
  });

  it("backend='fs' rejects with LegacyBackendError naming cq migrate; no .cq/ is created", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-init-fs-legacy-"));
    dirs.push(root);
    await writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n', "utf8");

    const err = await dispatch(["init", "--cwd", root], recordingIo()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LegacyBackendError);
    expect((err as Error).message).toContain("cq migrate");
    await expect(stat(path.join(root, ".cq"))).rejects.toThrow();
  });
});
