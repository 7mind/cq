/**
 * createLedgerStore / git-env / gitignore tests (T357 / G43).
 *
 * Covers the four acceptance-mandated focuses for the integration factory:
 *  1. the factory returns the backend selected by cq.toml's `[ledger]` table
 *     (fs default / explicit fs / git-object);
 *  2. the git-env fail-fast (`assertGitWorkTree`) on a non-git cwd and a
 *     git-object factory call from outside a work tree;
 *  3. the idempotent `ensureGitBackendGitignore` helper (create / append /
 *     no-duplicate).
 *
 * Throwaway dirs/repos via `mkdtemp`; cleaned up in `afterAll`.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  resolveLedgerBackend,
  assertGitWorkTree,
  GitEnvironmentError,
  FsLedgerStore,
  GitObjectLedgerBackend,
  ensureGitBackendGitignore,
  GIT_BACKEND_GITIGNORE_MARKER,
} from "../src/index.js";

const exec = promisify(execFile);
const dirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd, encoding: "utf8" });
}

/** A throwaway non-git directory. */
async function plainDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "cls-plain-"));
  dirs.push(dir);
  return dir;
}

/** A throwaway initialised git repo with one commit. */
async function gitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "cls-git-"));
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "src.txt"), "x\n");
  await git(dir, "add", "src.txt");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function writeCqToml(dir: string, body: string): Promise<void> {
  await fs.writeFile(path.join(dir, "cq.toml"), body, "utf8");
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("resolveLedgerBackend", () => {
  it("defaults to fs when no cq.toml is present", async () => {
    const dir = await plainDir();
    expect(resolveLedgerBackend(dir)).toEqual({ backend: "fs", branch: "cq-ledger" });
  });

  it("defaults to fs when cq.toml has no [ledger] table", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, 'reviewers = []\nplanners = []\n');
    expect(resolveLedgerBackend(dir).backend).toBe("fs");
  });

  it("reads backend + branch from the [ledger] table", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\nbranch = "my-ledger"\n');
    expect(resolveLedgerBackend(dir)).toEqual({ backend: "git-object", branch: "my-ledger" });
  });
});

describe("createLedgerStore — backend selection", () => {
  it("returns an FsLedgerStore for the default (no cq.toml)", async () => {
    const dir = await plainDir();
    const { store, backend } = await createLedgerStore(dir);
    expect(backend).toBe("fs");
    expect(store).toBeInstanceOf(FsLedgerStore);
    await store.dispose();
  });

  it("returns an FsLedgerStore for explicit backend='fs'", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "fs"\n');
    const { store, backend } = await createLedgerStore(dir);
    expect(backend).toBe("fs");
    expect(store).toBeInstanceOf(FsLedgerStore);
    await store.dispose();
  });

  it("returns a GitObjectLedgerBackend for backend='git-object' in a git repo", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\n');
    const { store, backend, branch } = await createLedgerStore(dir);
    expect(backend).toBe("git-object");
    expect(branch).toBe("cq-ledger");
    expect(store).toBeInstanceOf(GitObjectLedgerBackend);
    // The ledger landed on the orphan ref (not the working tree).
    const { stdout } = await exec("git", ["log", "--oneline", "cq-ledger"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(stdout.trim().length).toBeGreaterThan(0);
    // The working tree stays clean — no .cq/ tracked on the working branch.
    const status = await exec("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(status.stdout.includes(".cq/")).toBe(false);
    await store.dispose();
  });

  it("git-object honours a custom [ledger].branch", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\nbranch = "custom-ref"\n');
    const { branch, store } = await createLedgerStore(dir);
    expect(branch).toBe("custom-ref");
    const { stdout } = await exec("git", ["log", "--oneline", "custom-ref"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(stdout.trim().length).toBeGreaterThan(0);
    await store.dispose();
  });
});

describe("assertGitWorkTree — git-env fail-fast", () => {
  it("throws GitEnvironmentError for a non-git directory", async () => {
    const dir = await plainDir();
    expect(() => assertGitWorkTree(dir)).toThrow(GitEnvironmentError);
  });

  it("passes for a git work tree", async () => {
    const dir = await gitRepo();
    expect(() => assertGitWorkTree(dir)).not.toThrow();
  });

  it("createLedgerStore fails fast for git-object outside a git work tree", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\n');
    await expect(createLedgerStore(dir)).rejects.toBeInstanceOf(GitEnvironmentError);
  });
});

describe("ensureGitBackendGitignore — idempotent gitignore helper", () => {
  it("creates .gitignore with the marker block when absent", async () => {
    const dir = await plainDir();
    const wrote = await ensureGitBackendGitignore(dir);
    expect(wrote).toBe(true);
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(content).toContain(GIT_BACKEND_GITIGNORE_MARKER);
    expect(content).toContain(".cq/*.md");
    expect(content).toContain(".cq/ledgers.yaml");
  });

  it("appends the block preserving existing content", async () => {
    const dir = await plainDir();
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");
    const wrote = await ensureGitBackendGitignore(dir);
    expect(wrote).toBe(true);
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(GIT_BACKEND_GITIGNORE_MARKER);
  });

  it("is idempotent — a second call does not duplicate the block", async () => {
    const dir = await plainDir();
    await ensureGitBackendGitignore(dir);
    const wrote2 = await ensureGitBackendGitignore(dir);
    expect(wrote2).toBe(false);
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    const occurrences = content.split(GIT_BACKEND_GITIGNORE_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it("git-object startup leaves .cq/*.md + .cq/ledgers.yaml gitignored", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\n');
    const { store } = await createLedgerStore(dir);
    await store.dispose();
    // git check-ignore confirms the .cq projection is ignored on the work branch.
    const md = await exec("git", ["check-ignore", ".cq/tasks.md"], {
      cwd: dir,
      encoding: "utf8",
    }).then((r) => r.stdout.trim());
    expect(md).toBe(".cq/tasks.md");
    const yaml = await exec("git", ["check-ignore", ".cq/ledgers.yaml"], {
      cwd: dir,
      encoding: "utf8",
    }).then((r) => r.stdout.trim());
    expect(yaml).toBe(".cq/ledgers.yaml");
  });
});
