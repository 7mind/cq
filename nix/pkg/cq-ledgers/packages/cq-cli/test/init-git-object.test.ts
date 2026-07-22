/**
 * T505 as relaxed by K117: `cq init` with a cq.toml naming a LEGACY backend.
 *
 * An explicit legacy backend (fs / git-object) takes the warn-and-open path:
 * `cq init` bootstraps the legacy store (pre-T505 behavior) while a stderr
 * deprecation warning names `cq migrate`. (The T505 hard-refusal assertions
 * live in git history.)
 *
 * Throwaway repos via mkdtemp; cleaned up in afterAll.
 */

import { describe, it, expect, afterAll, spyOn } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
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

describe("cq init — legacy backends warn and open (K117)", () => {
  it("backend='git-object' warns DEPRECATED and seeds the orphan ref", async () => {
    const root = await gitRepo();
    // A pre-existing cq.toml selecting the legacy git-object backend.
    await writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "git-object"\n', "utf8");

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const outcome = await dispatch(["init", "--cwd", root], recordingIo());
      expect(outcome.exitCode).toBe(0);
      const warned = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(warned).toContain("DEPRECATED");
      expect(warned).toContain("'git-object'");
      expect(warned).toContain("cq migrate");
    } finally {
      stderrSpy.mockRestore();
    }

    // The orphan ref was seeded (pre-T505 git-object init behavior).
    const refExists = await exec(
      "git",
      ["rev-parse", "--verify", "-q", "refs/heads/cq-ledger"],
      { cwd: root, encoding: "utf8" },
    ).then(
      () => true,
      () => false,
    );
    expect(refExists).toBe(true);
    // The git-object backend keeps state in the ref, not a .cq/ tree.
    await expect(stat(path.join(root, ".cq"))).rejects.toThrow();
  });

  it("backend='fs' warns DEPRECATED and bootstraps the in-tree .cq/ store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-init-fs-legacy-"));
    dirs.push(root);
    await writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n', "utf8");

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const outcome = await dispatch(["init", "--cwd", root], recordingIo());
      expect(outcome.exitCode).toBe(0);
      const warned = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(warned).toContain("DEPRECATED");
      expect(warned).toContain("cq migrate");
    } finally {
      stderrSpy.mockRestore();
    }
    await expect(stat(path.join(root, ".cq", "ledgers.yaml"))).resolves.toBeDefined();
  });
});
