/**
 * T501: `cq init` / `cq erase` — the out-of-tree xdg backend, now the DEFAULT
 * for a fresh `cq init` (cqTomlTemplate.ts).
 *
 * End-to-end acceptance:
 *   (a) `cq init` in a git repo, with XDG_STATE_HOME overridden, writes
 *       cq.toml (backend='xdg' per the new default) and creates NO local
 *       `.cq/` tree — the store lives at
 *       `<XDG_STATE_HOME>/cq/projects/<projectKey>/state/ledger.db`.
 *       `createLedgerStore` — the SAME factory ledger-mcp's
 *       `createEmbeddedStore` (embedded TUI/web + in-process MCP) AND the
 *       standalone `cq mcp` stdio host both route through — resolves back to
 *       that IDENTICAL sqlite file, so MCP tools (embedded or standalone)
 *       operate on the exact store `cq init` built, not a divergent copy.
 *   (b) `cq erase` removes EXACTLY this project's out-of-tree directory under
 *       the XDG base — a sibling project's directory (a different repo, hence
 *       a different projectKey) survives untouched.
 *   (c) `cq init`'s xdg default FAILS FAST with an actionable message outside
 *       a git work tree (no stable project identity to key the store off).
 *
 * Throwaway repos via mkdtemp; XDG_STATE_HOME saved/restored per test so
 * nothing here ever touches the real machine's XDG state.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createLedgerStore, resolveStateDir, resolveStateDirBase } from "@cq/ledger";
import { createEmbeddedStore } from "@cq/ledger-mcp";
import {
  dispatch,
  CQ_CONFIG_FILENAME,
  type ConfirmIo,
  type DispatchIo,
} from "../src/main.js";
import { CQ_TOML_TEMPLATE } from "../src/cqTomlTemplate.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
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

/** A throwaway initialised git repo with one commit (the xdg backend's identity key). */
async function gitRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  // Distinct content per repo (keyed by the tmp prefix) so two repos created
  // back-to-back never collide on an identical commit SHA (same tree + same
  // author/committer timestamp to the second would otherwise hash equal).
  await fs.writeFile(path.join(dir, "README.md"), `# repo ${prefix}\n`);
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function firstCommitSha(dir: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("cq init / erase — xdg out-of-tree backend, the fresh-init default (T501)", () => {
  let originalXdgStateHome: string | undefined;

  beforeEach(async () => {
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "cq-init-xdg-home-"));
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

  it("(a) cq init defaults to xdg + creates the store out of tree; createLedgerStore (the ledger-mcp embedded/standalone factory) resolves the SAME store", async () => {
    const root = await gitRepo("cq-init-xdg-");
    const io = recordingIo();
    const outcome = await dispatch(["init", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);

    const configPath = path.join(root, CQ_CONFIG_FILENAME);
    const tomlContent = await fs.readFile(configPath, "utf8");
    expect(tomlContent).toBe(CQ_TOML_TEMPLATE);
    expect(tomlContent).toMatch(/backend\s*=\s*"xdg"/);

    // No local .cq/ tree at all — the store lives entirely out of tree.
    expect(await exists(path.join(root, ".cq"))).toBe(false);

    const projectKey = await firstCommitSha(root);
    const expectedDbPath = path.join(resolveStateDir(projectKey), "ledger.db");
    expect((await fs.stat(expectedDbPath)).isFile()).toBe(true);

    // ledger-mcp's createEmbeddedStore(cwd) is `return createLedgerStore(cwd)`
    // verbatim (embedded TUI/web + in-process MCP path); the standalone `cq mcp`
    // stdio host calls createLedgerStore directly too. Re-resolving here proves
    // BOTH consumers land on the IDENTICAL file cq init just built, not a
    // second, divergent store.
    const embedded = await createEmbeddedStore(root);
    try {
      expect(embedded.backend).toBe("xdg");
      expect(embedded.dbPath).toBe(expectedDbPath);
      expect(embedded.store.enumerate()).toContain("tasks");
      // Write through the "embedded MCP" handle...
      const m = await embedded.store.createMilestone({ title: "mcp smoke" });
      expect(m.id).toBe("M1");
    } finally {
      await embedded.store.dispose();
    }

    // ...and confirm a THIRD, independent resolution (mirroring what a
    // standalone `cq mcp --cwd <root>` process would do) reads it straight
    // back — same underlying file, not a copy.
    const again = await createLedgerStore(root);
    try {
      expect(again.dbPath).toBe(expectedDbPath);
      expect(again.store.fetchMilestone("M1").milestone.fields["title"]).toBe("mcp smoke");
    } finally {
      await again.store.dispose();
    }
  });

  it("(b) cq erase removes EXACTLY this project's store dir under the XDG base — a sibling project's dir survives", async () => {
    const rootA = await gitRepo("cq-erase-xdg-a-");
    const rootB = await gitRepo("cq-erase-xdg-b-");

    await dispatch(["init", "--cwd", rootA], recordingIo());
    await dispatch(["init", "--cwd", rootB], recordingIo());

    const keyA = await firstCommitSha(rootA);
    const keyB = await firstCommitSha(rootB);
    const projectDirA = resolveStateDirBase(keyA);
    const projectDirB = resolveStateDirBase(keyB);
    expect((await fs.stat(projectDirA)).isDirectory()).toBe(true);
    expect((await fs.stat(projectDirB)).isDirectory()).toBe(true);

    const io = recordingIo();
    const outcome = await dispatch(["erase", "--cwd", rootA, "--yes"], io);
    expect(outcome.exitCode).toBe(0);

    // Project A's entire out-of-tree dir (state/ + logs/) is gone...
    expect(await exists(projectDirA)).toBe(false);
    // ...project B's dir (and everything else under the XDG base) survives.
    expect(await exists(projectDirB)).toBe(true);

    // cq.toml removed too (the bounded fs+config delete, unaffected by T501).
    expect(await exists(path.join(rootA, CQ_CONFIG_FILENAME))).toBe(false);

    // Report mentions the out-of-tree dir removed.
    expect(io.outs.join("\n")).toContain(`removed: ${projectDirA}`);
  });

  it("(c) cq init fails fast, actionably, outside a git work tree (xdg default has no stable project identity)", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "cq-init-xdg-nogit-"));
    dirs.push(root);
    // dispatch surfaces the thrown ProjectKeyResolutionError; assert it rejects
    // with a message actionable enough to point the user at the fix.
    await expect(dispatch(["init", "--cwd", root], recordingIo())).rejects.toThrow(
      /projectId/i,
    );
  });
});
