/** SQLite/XDG construction, explicit remote refusal, and harness-invariant configuration. */

import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  RemoteLedgerClientNotWiredError,
  resolveLedgerBackend,
  SqliteLedgerStore,
  resolveStateDir,
  ProjectKeyResolutionError,
} from "../src/index.js";

import { useIsolatedXdgSuite } from "../../cq-config/test/xdgSuiteFixture.js";

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

useIsolatedXdgSuite(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("resolveLedgerBackend", () => {
  it("defaults to xdg (K117) when no cq.toml is present, with explicit=false", async () => {
    const dir = await plainDir();
    expect(resolveLedgerBackend(dir)).toEqual({
      backend: "xdg",
      branch: "cq-ledger",
      explicit: false,
    });
  });

  it("defaults to xdg when cq.toml has no [ledger] table, with explicit=false", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, 'reviewers = []\nplanners = []\n');
    expect(resolveLedgerBackend(dir)).toEqual({
      backend: "xdg",
      branch: "cq-ledger",
      explicit: false,
    });
  });

  it("defaults to xdg when the [ledger] table has no backend key, with explicit=false", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackup = "none"\n');
    expect(resolveLedgerBackend(dir)).toEqual({
      backend: "xdg",
      branch: "cq-ledger",
      explicit: false,
    });
  });

  it("reads backend + branch from the [ledger] table, with explicit=true", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "xdg"\nbranch = "my-ledger"\n');
    expect(resolveLedgerBackend(dir)).toEqual({
      backend: "xdg",
      branch: "my-ledger",
      explicit: true,
    });
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
        'backend = "xdg"',
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

      expect(underPi).toEqual({ backend: "xdg", branch: "cq-ledger", explicit: true });
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

  it("T861: a SHARED-only read stays readable under CQ_HARNESS=codex with no [harness.codex] block", async () => {
    // The codex fail-closed rule (T861) governs the DISPATCH-PANEL domain
    // (reviewers / planners / [tiers]). `[ledger]` is a SHARED section that is
    // never per-harness overridden, so resolving the backend must NOT be gated
    // by it: `cq mcp`, `cq log put`, `cq migrate` and the store factory all read
    // this path while a codex-hosted invocation exports CQ_HARNESS=codex.
    const dir = await plainDir();
    await writeCqToml(
      dir,
      [
        'reviewers = ["opus"]',
        'planners  = ["opus"]',
        "",
        "[aliases]",
        'opus = "claude:opus-4.8[1m]"',
        "",
        "[tiers]",
        'frontier = "opus"',
        "",
        "[ledger]",
        'backend = "xdg"',
        'branch  = "cq-ledger"',
      ].join("\n") + "\n",
    );

    const prev = process.env["CQ_HARNESS"];
    try {
      process.env["CQ_HARNESS"] = "codex";
      const underCodex = resolveLedgerBackend(dir);

      process.env["CQ_HARNESS"] = "claude";
      const underClaude = resolveLedgerBackend(dir);

      expect(underCodex).toEqual({ backend: "xdg", branch: "cq-ledger", explicit: true });
      expect(underCodex).toEqual(underClaude);
    } finally {
      if (prev === undefined) {
        delete process.env["CQ_HARNESS"];
      } else {
        process.env["CQ_HARNESS"] = prev;
      }
    }
  });
});

describe("createLedgerStore — local SQLite selection", () => {
  let stderrSpy: Mock<typeof process.stderr.write>;
  const stderrText = (): string =>
    stderrSpy.mock.calls.map((c) => String(c[0])).join("");

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("the no-cq.toml default resolves to the xdg store — no .cq/ is created, no warning on a clean root", async () => {
    const dir = await gitRepo();
    const { store, backend } = await createLedgerStore(dir);
    try {
      expect(backend).toBe("xdg");
      expect(store).toBeInstanceOf(SqliteLedgerStore);
      await expect(fs.stat(path.join(dir, ".cq"))).rejects.toThrow();
      expect(stderrText()).toBe("");
    } finally {
      await store.dispose();
    }
  });

  it("default SQLite selection leaves an in-tree portable backup untouched", async () => {
    const dir = await gitRepo();
    await fs.mkdir(path.join(dir, ".cq"), { recursive: true });
    await fs.writeFile(path.join(dir, ".cq", "ledgers.yaml"), "ledgers: []\n");
    const { store, backend } = await createLedgerStore(dir);
    try {
      expect(backend).toBe("xdg");
      expect(stderrText()).toBe("");
      expect(await fs.readFile(path.join(dir, ".cq", "ledgers.yaml"), "utf8")).toBe("ledgers: []\n");
    } finally {
      await store.dispose();
    }
  });

  it("explicit SQLite selection leaves an in-tree portable backup untouched", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "xdg"\n');
    await fs.mkdir(path.join(dir, ".cq"), { recursive: true });
    await fs.writeFile(path.join(dir, ".cq", "ledgers.yaml"), "ledgers: []\n");
    const { store } = await createLedgerStore(dir);
    try {
      expect(stderrText()).toBe("");
    } finally {
      await store.dispose();
    }
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

describe("createLedgerStore — public postgres backend retired (T736)", () => {
  it("backend=postgres is not a valid public config", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "postgres"\n');
    await expect(createLedgerStore(dir)).rejects.toThrow(/not a valid backend/);
  });
});

describe("createLedgerStore — remote client boundary", () => {
  it("refuses an unwired remote client before local persistence or identity resolution [Blackbox-GoodCommunication]", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "remote"\nserverUrl = "https://ledger.example.test"\n');
    const before = await fs.readdir(dir);
    await expect(createLedgerStore(dir)).rejects.toBeInstanceOf(RemoteLedgerClientNotWiredError);
    expect(await fs.readdir(dir)).toEqual(before);
  });
});
