/**
 * createLedgerStore / openLegacyLedgerStore / git-env tests (T357 / G43;
 * legacy cutover T505 / G67).
 *
 * Covers the factory contract after the legacy cutover (T505) as relaxed by
 * K117 (xdg default + legacy warnings):
 *  1. the DEFAULT backend (no cq.toml / no `[ledger]` / no `backend` key) is
 *     'xdg'; an EXPLICIT legacy `fs` / `git-object` opens the in-tree store
 *     with a stderr deprecation warning naming `cq migrate`;
 *  2. `backend = 'xdg'` resolves to a working SqliteLedgerStore under the XDG
 *     state dir (and a shallow clone fails fast with
 *     ProjectKeyResolutionError); a DEFAULT-resolved xdg over a root carrying
 *     a legacy `.cq/ledgers.yaml` warns that the in-tree ledger is shadowed;
 *  3. `openLegacyLedgerStore` — the read path `cq migrate` uses — constructs
 *     the legacy stores (incl. via the explicit backend override), and
 *     refuses an xdg config;
 *  4. the git-env fail-fast (`assertGitWorkTree`) on a non-git cwd.
 *
 * Throwaway dirs/repos via `mkdtemp`; cleaned up in `afterAll`.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  openLegacyLedgerStore,
  resolveLedgerBackend,
  assertGitWorkTree,
  GitEnvironmentError,
  PostgresLedgerStore,
  FsLedgerStore,
  GitObjectLedgerBackend,
  SqliteLedgerStore,
  resolveStateDir,
  ProjectKeyResolutionError,
} from "../src/index.js";
import { PostgresDsnResolutionError } from "../src/store/postgres/dsn.js";

const exec = promisify(execFile);
const dirs: string[] = [];
const PG_URL = process.env.CQ_TEST_PG_URL;

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

/**
 * A throwaway initialised git repo with a UNIQUE first commit (unlike
 * {@link gitRepo}'s fixed content) — the postgres tests below share a REAL
 * database, so two dirs colliding on the same commit SHA (and therefore the
 * same `projectKey` tenant) would cross-contaminate each other's rows. Mirrors
 * log-put-postgres.test.ts's `postgresRepo` helper.
 */
async function pgGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "cls-pg-"));
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "README.md"), `# repo ${randomUUID()}\n`);
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function projectKeyOf(dir: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  });
  return stdout.trim();
}

afterAll(async () => {
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
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\nbranch = "my-ledger"\n');
    expect(resolveLedgerBackend(dir)).toEqual({
      backend: "git-object",
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

      expect(underPi).toEqual({ backend: "fs", branch: "cq-ledger", explicit: true });
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

describe("createLedgerStore — legacy backends warn and open (K117, was T505's hard refusal)", () => {
  let stderrSpy: Mock<typeof process.stderr.write>;
  const stderrText = (): string =>
    stderrSpy.mock.calls.map((c) => String(c[0])).join("");

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("explicit backend='fs' opens an FsLedgerStore with a deprecation warning naming cq migrate", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "fs"\n');
    const { store, backend } = await createLedgerStore(dir);
    try {
      expect(backend).toBe("fs");
      expect(store).toBeInstanceOf(FsLedgerStore);
      expect(stderrText()).toContain("DEPRECATED");
      expect(stderrText()).toContain("'fs'");
      expect(stderrText()).toContain("cq migrate");
    } finally {
      await store.dispose();
    }
  });

  it("explicit backend='git-object' opens a GitObjectLedgerBackend with a deprecation warning", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\n');
    const { store, backend } = await createLedgerStore(dir);
    try {
      expect(backend).toBe("git-object");
      expect(store).toBeInstanceOf(GitObjectLedgerBackend);
      expect(stderrText()).toContain("DEPRECATED");
      expect(stderrText()).toContain("'git-object'");
      expect(stderrText()).toContain("cq migrate");
    } finally {
      await store.dispose();
    }
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

  it("a DEFAULT-resolved xdg over a root carrying .cq/ledgers.yaml warns that the legacy ledger is shadowed", async () => {
    const dir = await gitRepo();
    await fs.mkdir(path.join(dir, ".cq"), { recursive: true });
    await fs.writeFile(path.join(dir, ".cq", "ledgers.yaml"), "ledgers: []\n");
    const { store, backend } = await createLedgerStore(dir);
    try {
      expect(backend).toBe("xdg");
      expect(stderrText()).toContain("legacy in-tree ledger");
      expect(stderrText()).toContain("NOT read");
      expect(stderrText()).toContain("cq migrate");
    } finally {
      await store.dispose();
    }
  });

  it("an EXPLICIT backend='xdg' over the same legacy tree does NOT warn (deliberate choice)", async () => {
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

  it("the explicit backend override opens an fs source on a cq.toml-less root (K117 migrate path)", async () => {
    const dir = await plainDir();
    const { store, backend } = await openLegacyLedgerStore(dir, "fs");
    expect(backend).toBe("fs");
    expect(store).toBeInstanceOf(FsLedgerStore);
    await store.dispose();
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

describe("createLedgerStore — postgres backend (T577, G81/M248)", () => {
  const ORIGINAL_PG_ENV_VARS = [
    "CQ_LEDGER_PG_URL",
    "DATABASE_URL",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGSERVICE",
    "PGSSLMODE",
    "PGOPTIONS",
    "PGPASSFILE",
    "PGAPPNAME",
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const name of ORIGINAL_PG_ENV_VARS) {
      savedEnv[name] = process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("backend='fs' still takes the legacy warn-and-open path (unaffected by the postgres branch)", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "fs"\n');
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { store } = await createLedgerStore(dir);
      expect(store).toBeInstanceOf(FsLedgerStore);
      await store.dispose();
    } finally {
      spy.mockRestore();
    }
  });

  it("missing DSN throws PostgresDsnResolutionError — no connection attempted, no server needed", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "postgres"\n');
    for (const name of ORIGINAL_PG_ENV_VARS) {
      delete process.env[name];
    }
    await expect(createLedgerStore(dir)).rejects.toBeInstanceOf(PostgresDsnResolutionError);
  });

  describe.skipIf(!PG_URL)("live round-trip (CQ_TEST_PG_URL)", () => {
    it("resolves a working PostgresLedgerStore: canonical ledgers present, createItem/fetchItem round-trip", async () => {
      const dir = await pgGitRepo();
      await writeCqToml(dir, '[ledger]\nbackend = "postgres"\n');
      const expectedProjectKey = await projectKeyOf(dir);
      process.env["CQ_LEDGER_PG_URL"] = PG_URL;

      const resolved = await createLedgerStore(dir);
      try {
        expect(resolved.backend).toBe("postgres");
        expect(resolved.store).toBeInstanceOf(PostgresLedgerStore);
        // dbPath/logsDir stay undefined — logs + ledger rows both live in the DB.
        expect(resolved.dbPath).toBeUndefined();
        expect(resolved.logsDir).toBeUndefined();
        expect(resolved.pg).toBeDefined();
        expect(resolved.pg?.projectKey).toBe(expectedProjectKey);

        // Canonical ledgers were bootstrapped for this fresh tenant.
        expect(resolved.store.enumerate()).toContain("tasks");
        expect(resolved.store.enumerate()).toContain("defects");

        const milestone = await resolved.store.createMilestone({ title: "T577 pg smoke" });
        const created = await resolved.store.createItem("tasks", milestone.id, {
          status: "planned",
          fields: { headline: "round-trip via createLedgerStore" },
        });
        const fetched = resolved.store.fetchItem("tasks", created.id);
        expect(fetched.id).toBe(created.id);
        expect(fetched.fields["headline"]).toBe("round-trip via createLedgerStore");
      } finally {
        await resolved.store.dispose();
      }
    });

    it("displayName chain: cq.toml [project].name wins over the repo basename / projectKey rungs", async () => {
      const dir = await pgGitRepo();
      await writeCqToml(dir, '[ledger]\nbackend = "postgres"\n\n[project]\nname = "T577 Display Name"\n');
      const expectedProjectKey = await projectKeyOf(dir);
      process.env["CQ_LEDGER_PG_URL"] = PG_URL;

      const resolved = await createLedgerStore(dir);
      try {
        const pool = resolved.pg?.pool;
        expect(pool).toBeDefined();
        const rows = await pool!<Array<{ display_name: string }>>`
          SELECT display_name FROM projects WHERE project_key = ${expectedProjectKey}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.display_name).toBe("T577 Display Name");
      } finally {
        await resolved.store.dispose();
      }
    });
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
