/**
 * T357: `cq init` with backend='git-object' on a fresh git repo.
 *
 * Acceptance (R418 / T445): a fresh git-object init leaves .cq/*.md + .cq/ledgers.yaml
 * GITIGNORED on the working branch (never accidentally tracked), and the ledger
 * lands on the orphan ref rather than the working tree. backend='fs' (the
 * default, covered by init.test.ts) is unaffected.
 *
 * Throwaway repos via mkdtemp; cleaned up in afterAll.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("cq init — backend='git-object'", () => {
  it("leaves .cq/*.md + .cq/ledgers.yaml gitignored (not tracked) on the work branch", async () => {
    const root = await gitRepo();
    // A pre-existing cq.toml selecting the git-object backend (cq init reads it).
    await writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "git-object"\n', "utf8");

    const io = recordingIo();
    const outcome = await dispatch(["init", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);

    // .cq projection is gitignored.
    const md = await exec("git", ["check-ignore", ".cq/tasks.md"], {
      cwd: root,
      encoding: "utf8",
    }).then((r) => r.stdout.trim());
    expect(md).toBe(".cq/tasks.md");
    const yaml = await exec("git", ["check-ignore", ".cq/ledgers.yaml"], {
      cwd: root,
      encoding: "utf8",
    }).then((r) => r.stdout.trim());
    expect(yaml).toBe(".cq/ledgers.yaml");

    // Nothing under .cq/ is staged/tracked on the working branch.
    const status = await exec("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).then((r) => r.stdout);
    expect(status.includes(".cq/")).toBe(false);

    // The ledger landed on the orphan ref.
    const log = await exec("git", ["log", "--oneline", "cq-ledger"], {
      cwd: root,
      encoding: "utf8",
    }).then((r) => r.stdout.trim());
    expect(log.length).toBeGreaterThan(0);
  });

  it("fails fast for backend='git-object' outside a git work tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-init-nogit-"));
    dirs.push(root);
    await writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "git-object"\n', "utf8");
    // dispatch surfaces the thrown GitEnvironmentError; assert it rejects.
    await expect(dispatch(["init", "--cwd", root], recordingIo())).rejects.toThrow(
      /git work tree/i,
    );
  });
});
