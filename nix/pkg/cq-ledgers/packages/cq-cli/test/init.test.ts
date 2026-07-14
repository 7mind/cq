/**
 * T189 + T338: `cq init` — idempotent create-empty-ledgers-if-none + cq.toml write.
 *
 * (a)/(b) — T505: a cq.toml pinning the LEGACY backend='fs' no longer selects
 * a runtime primary; `cq init` on such a root fails fast with the documented
 * LegacyBackendError naming `cq migrate` and creates no .cq/ tree. (The
 * historical fs init-path assertions live in git history / T189.)
 *
 * T338 asserts, on a truly FRESH init (git repo + XDG_STATE_HOME override, so
 * the new xdg default resolves and nothing touches the real machine state):
 *   (c) `cq init` on a fresh root creates cq.toml whose content === CQ_TOML_TEMPLATE.
 *   (d) A second `cq init` leaves cq.toml byte-identical and emits the skip message (exit 0).
 *   (e) `cq init --force` overwrites a modified cq.toml back to the template.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  dispatch,
  CQ_CONFIG_FILENAME,
  type ConfirmIo,
  type DispatchIo,
} from "../src/main.js";
import { CQ_TOML_TEMPLATE } from "../src/cqTomlTemplate.js";
import { LegacyBackendError, LEDGER_STORAGE_DIRNAME } from "@cq/ledger";

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

function recordingIo(): DispatchIo & { outs: string[] } {
  const outs: string[] = [];
  return {
    outs,
    out: (l) => outs.push(l),
    err: () => {},
    confirm: silentConfirm,
  };
}

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-init-"));
  dirs.push(dir);
  return dir;
}

/** A throwaway initialised git repo with one commit (needed for the xdg default, T501). */
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

describe("cq init", () => {
  it("(a/b — T505) backend='fs' pinned: rejects with LegacyBackendError naming cq migrate, creates no .cq/", async () => {
    const root = await makeTmpDir();
    await writeFile(path.join(root, CQ_CONFIG_FILENAME), '[ledger]\nbackend = "fs"\n', "utf8");

    const err = await dispatch(["init", "--cwd", root], recordingIo()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LegacyBackendError);
    expect((err as Error).message).toContain("cq migrate");

    // No .cq/ tree was created.
    await expect(stat(path.join(root, LEDGER_STORAGE_DIRNAME))).rejects.toThrow();
  });

  describe("on a fresh root (xdg default, T501)", () => {
    let originalXdgStateHome: string | undefined;

    beforeEach(async () => {
      originalXdgStateHome = process.env["XDG_STATE_HOME"];
      const xdgHome = await mkdtemp(path.join(tmpdir(), "cq-init-xdg-home-"));
      dirs.push(xdgHome);
      process.env["XDG_STATE_HOME"] = xdgHome;
    });

    afterEach(() => {
      if (originalXdgStateHome === undefined) {
        delete process.env["XDG_STATE_HOME"];
      } else {
        process.env["XDG_STATE_HOME"] = originalXdgStateHome;
      }
    });

    it("(c) cq init creates cq.toml with content === CQ_TOML_TEMPLATE", async () => {
      const root = await gitRepo();
      const io = recordingIo();
      const outcome = await dispatch(["init", "--cwd", root], io);
      expect(outcome.exitCode).toBe(0);

      const configPath = path.join(root, CQ_CONFIG_FILENAME);
      const content = await readFile(configPath, "utf8");
      expect(content).toBe(CQ_TOML_TEMPLATE);

      // output should mention writing the config file
      expect(io.outs.some((l) => l.includes("wrote") && l.includes(CQ_CONFIG_FILENAME))).toBe(true);
    });

    it("(d) second cq init leaves cq.toml byte-identical and emits skip message (exit 0)", async () => {
      const root = await gitRepo();
      await dispatch(["init", "--cwd", root], recordingIo());

      const configPath = path.join(root, CQ_CONFIG_FILENAME);
      const before = await readFile(configPath, "utf8");
      expect(before).toBe(CQ_TOML_TEMPLATE);

      const io2 = recordingIo();
      const outcome2 = await dispatch(["init", "--cwd", root], io2);
      expect(outcome2.exitCode).toBe(0);

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(before);

      // skip message should mention --force
      expect(io2.outs.some((l) => l.includes("already exists") && l.includes("--force"))).toBe(true);
    });

    it("(e) cq init --force overwrites a modified cq.toml back to the template", async () => {
      const root = await gitRepo();
      await dispatch(["init", "--cwd", root], recordingIo());

      const configPath = path.join(root, CQ_CONFIG_FILENAME);
      // Modify the file
      await writeFile(configPath, "# modified\n", "utf8");
      const modified = await readFile(configPath, "utf8");
      expect(modified).toBe("# modified\n");

      const io2 = recordingIo();
      const outcome2 = await dispatch(["init", "--cwd", root, "--force"], io2);
      expect(outcome2.exitCode).toBe(0);

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(CQ_TOML_TEMPLATE);

      // output should mention overwriting
      expect(io2.outs.some((l) => l.includes("overwrote") && l.includes(CQ_CONFIG_FILENAME))).toBe(true);
    });
  });
});
