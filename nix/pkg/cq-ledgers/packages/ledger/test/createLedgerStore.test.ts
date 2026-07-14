/**
 * createLedgerStore / openLegacyLedgerStore / git-env tests (T357 / G43;
 * legacy cutover T505 / G67).
 *
 * Covers the factory contract after the legacy cutover:
 *  1. cq.toml naming a LEGACY backend (`fs` explicit, `fs` via the no-cq.toml
 *     default, `git-object`) FAILS FAST with the documented
 *     {@link LegacyBackendError} naming `cq migrate` — the legacy backends are
 *     no longer selectable runtime primaries;
 *  2. `backend = 'xdg'` resolves to a working SqliteLedgerStore under the XDG
 *     state dir (and a shallow clone fails fast with
 *     ProjectKeyResolutionError);
 *  3. `openLegacyLedgerStore` — the INTERNAL read path `cq migrate` uses —
 *     still constructs the legacy stores, and refuses an xdg config;
 *  4. the git-env fail-fast (`assertGitWorkTree`) on a non-git cwd.
 *
 * Throwaway dirs/repos via `mkdtemp`; cleaned up in `afterAll`.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  openLegacyLedgerStore,
  resolveLedgerBackend,
  assertGitWorkTree,
  GitEnvironmentError,
  LegacyBackendError,
  FsLedgerStore,
  GitObjectLedgerBackend,
  SqliteLedgerStore,
  resolveStateDir,
  ProjectKeyResolutionError,
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

  it("T483: [ledger] backend is harness-invariant — CQ_HARNESS=pi yields same backend as unset", async () => {
    // A cq.toml with a [harness.pi] override block and a shared [ledger] section.
    // resolveLedgerBackend must return the SAME backend/branch regardless of the
    // active harness signalled via CQ_HARNESS (save-and-restore idiom).
    const dir = await plainDir();
    await writeCqToml(
      dir,
      [
        'reviewers = ["opus"]',
        'planners  = ["opus"]',
        "",
        "[aliases]",
        'opus = "claude:opus-4.8[1m]"',
        'grok = "pi:grok-build/grok-build"',
        "",
        "[ledger]",
        'backend = "fs"',
        'branch  = "cq-ledger"',
        "",
        "[harness.pi]",
        'reviewers = ["grok"]',
        'planners  = ["grok"]',
      ].join("\n") + "\n",
    );

    const prev = process.env["CQ_HARNESS"];
    try {
      process.env["CQ_HARNESS"] = "pi";
      const underPi = resolveLedgerBackend(dir);

      process.env["CQ_HARNESS"] = "claude";
      const underClaude = resolveLedgerBackend(dir);

      delete process.env["CQ_HARNESS"];
      const underUnset = resolveLedgerBackend(dir);

      expect(underPi).toEqual({ backend: "fs", branch: "cq-ledger" });
      expect(underClaude).toEqual(underPi);
      expect(underUnset).toEqual(underPi);
    } finally {
      if (prev === undefined) {
        delete process.env["CQ_HARNESS"];
      } else {
        process.env["CQ_HARNESS"] = prev;
      }
    }
  });
});

describe("createLedgerStore — legacy backends are no longer runtime primaries (T505)", () => {
  it("rejects the no-cq.toml default (fs) with LegacyBackendError naming cq migrate", async () => {
    const dir = await plainDir();
    const err = await createLedgerStore(dir).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LegacyBackendError);
    expect((err as Error).message).toContain("cq migrate");
    expect((err as Error).message).toContain("'fs'");
    // Nothing was constructed: no .cq/ tree appeared.
    await expect(fs.stat(path.join(dir, ".cq"))).rejects.toThrow();
  });

  it("rejects explicit backend='fs' with LegacyBackendError naming cq migrate", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "fs"\n');
    const err = await createLedgerStore(dir).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LegacyBackendError);
    expect((err as Error).message).toContain("cq migrate");
  });

  it("rejects backend='git-object' with LegacyBackendError naming cq migrate (even in a git repo)", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\n');
    const err = await createLedgerStore(dir).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LegacyBackendError);
    expect((err as Error).message).toContain("cq migrate");
    expect((err as Error).message).toContain("'git-object'");
    // The orphan ref was never seeded.
    const refCheck = await exec("git", ["rev-parse", "--verify", "-q", "refs/heads/cq-ledger"], {
      cwd: dir,
      encoding: "utf8",
    }).then(
      () => true,
      () => false,
    );
    expect(refCheck).toBe(false);
  });
});

describe("openLegacyLedgerStore — the internal cq-migrate read path (T505)", () => {
  it("opens an FsLedgerStore for the fs backend", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "fs"\n');
    const { store, backend } = await openLegacyLedgerStore(dir);
    expect(backend).toBe("fs");
    expect(store).toBeInstanceOf(FsLedgerStore);
    await store.dispose();
  });

  it("opens a GitObjectLedgerBackend honouring [ledger].branch for git-object", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\nbranch = "custom-ref"\n');
    const { store, backend, branch } = await openLegacyLedgerStore(dir);
    expect(backend).toBe("git-object");
    expect(branch).toBe("custom-ref");
    expect(store).toBeInstanceOf(GitObjectLedgerBackend);
    await store.dispose();
  });

  it("fails fast (GitEnvironmentError) for git-object outside a git work tree", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\n');
    await expect(openLegacyLedgerStore(dir)).rejects.toBeInstanceOf(GitEnvironmentError);
  });

  it("refuses an xdg config (nothing legacy to open)", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "xdg"\n');
    await expect(openLegacyLedgerStore(dir)).rejects.toThrow(/not a legacy/);
  });
});

describe("createLedgerStore — xdg backend (T530)", () => {
  let originalXdgStateHome: string | undefined;

  beforeEach(() => {
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
  });

  afterEach(() => {
    if (originalXdgStateHome === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = originalXdgStateHome;
    }
  });

  it("resolves through createLedgerStore to an initialised SqliteLedgerStore under <XDG_STATE_HOME>/cq/projects/<projectKey>/state/", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "xdg"\n');
    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "cls-xdg-home-"));
    dirs.push(xdgHome);
    process.env["XDG_STATE_HOME"] = xdgHome;

    const { stdout: sha } = await exec("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    });
    const projectKey = sha.trim();
    const expectedStateDir = resolveStateDir(projectKey);
    const expectedDbPath = path.join(expectedStateDir, "ledger.db");

    const { store, backend, dbPath } = await createLedgerStore(dir);
    try {
      expect(backend).toBe("xdg");
      expect(store).toBeInstanceOf(SqliteLedgerStore);
      expect(dbPath).toBe(expectedDbPath);
      expect(dbPath).toBe(
        path.join(xdgHome, "cq", "projects", projectKey, "state", "ledger.db"),
      );
      // The db file exists and is a WORKING, initialised store (bootstrapped
      // canonical ledgers + M-AMBIENT), not just a bare resolved path.
      const stat = await fs.stat(expectedDbPath);
      expect(stat.isFile()).toBe(true);
      expect(store.enumerate()).toContain("defects");
      const m = await store.createMilestone({ title: "xdg smoke" });
      expect(m.id).toBe("M1");
    } finally {
      await store.dispose();
    }
  });

  it("a shallow clone FAILS FAST with ProjectKeyResolutionError (no unstable boundary-SHA key)", async () => {
    const srcDir = await gitRepo();
    // A second commit so the shallow boundary commit is provably NOT the true
    // root (mirrors projectKey.test.ts's shallow-clone coverage).
    await fs.writeFile(path.join(srcDir, "second.txt"), "second\n");
    await git(srcDir, "add", "second.txt");
    await git(srcDir, "commit", "-q", "-m", "second commit");

    const shallowDir = await fs.mkdtemp(path.join(tmpdir(), "cls-shallow-"));
    await fs.rm(shallowDir, { recursive: true, force: true });
    // file:// is REQUIRED: git ignores --depth for plain-path local clones.
    await exec("git", ["clone", "-q", "--depth", "1", `file://${srcDir}`, shallowDir]);
    dirs.push(shallowDir);
    await writeCqToml(shallowDir, '[ledger]\nbackend = "xdg"\n');

    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "cls-xdg-home-shallow-"));
    dirs.push(xdgHome);
    process.env["XDG_STATE_HOME"] = xdgHome;

    await expect(createLedgerStore(shallowDir)).rejects.toBeInstanceOf(
      ProjectKeyResolutionError,
    );
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
});
